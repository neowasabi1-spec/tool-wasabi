import { NextResponse } from 'next/server';
import { fetchSavedPrompts } from '@/lib/supabase-operations';
import { supabase } from '@/lib/supabaseClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/swipe/load-knowledge?projectId=<uuid>
 *
 * Carica TUTTA la knowledge che il tool ha costruito e che vogliamo
 * passare al worker (Neo / Morfeo) prima di un swipe / clone-rewrite.
 *
 * Sources:
 *  • saved_prompts (libreria personale, pagina /prompts) — solo le
 *    categorie rilevanti per uno swipe di landing: swipe, copy, clone,
 *    landing, general. Restituite ordinate per is_favorite desc,
 *    use_count desc, cosi' i preferiti / piu' usati arrivano prima.
 *  • projects.brief + projects.market_research del progetto attivo
 *    (se passato un ?projectId).
 *
 * NB: questo endpoint NON e' protetto da auth applicativa avanzata —
 * e' chiamato solo dai client del tool e ritorna soltanto dati che
 * l'utente ha gia' lui stesso messo in DB. Va bene cosi' per ora.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');
  const wantAllPrompts = url.searchParams.get('all') === '1';

  // ── Saved prompts ────────────────────────────────────────────────
  let promptsRaw: Awaited<ReturnType<typeof fetchSavedPrompts>> = [];
  try {
    promptsRaw = await fetchSavedPrompts();
  } catch (e) {
    console.warn('[swipe/load-knowledge] fetchSavedPrompts failed:', e);
  }

  const RELEVANT = new Set(['swipe', 'copy', 'clone', 'landing', 'general']);
  const prompts = (promptsRaw || []).filter(
    (p) => wantAllPrompts || RELEVANT.has(String(p.category || '').toLowerCase()),
  );

  // ── Project knowledge ────────────────────────────────────────────
  let project: { id: string; name: string; brief: string | null; market_research: unknown; notes: string | null } | null = null;
  if (projectId) {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, brief, market_research, notes')
        .eq('id', projectId)
        .maybeSingle();
      if (error) throw error;
      if (data) project = data as typeof project;
    } catch (e) {
      console.warn('[swipe/load-knowledge] fetch project failed:', e);
    }
  }

  return NextResponse.json({
    success: true,
    prompts: prompts.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category,
      tags: p.tags || [],
      is_favorite: !!p.is_favorite,
    })),
    project,
    counts: {
      promptsTotal: promptsRaw.length,
      promptsFiltered: prompts.length,
      hasProject: !!project,
    },
  });
}
