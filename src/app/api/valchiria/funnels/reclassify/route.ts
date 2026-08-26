/**
 * POST /api/valchiria/funnels/reclassify
 *
 * Re-infer the page_type of already-saved funnel steps. Fixes walks saved
 * before the classifier existed, where every step was page_type 'landing'
 * and the whole funnel piled up in the "Landing Page" folder.
 *
 * Body: { ids: string[] }
 *   — archived_funnels row ids IN FUNNEL ORDER. Works both for walk
 *     folders (many single-step rows) and for real multi-step rows (one
 *     id, every step inside is reclassified in order).
 *
 * For each step we load the mirrored HTML from page_html (best signal),
 * infer the type from URL + title + HTML, and persist it into the step.
 * A shared upsell/downsell counter across the whole sequence produces the
 * upsell_1 / upsell_2 / … numbering.
 *
 * Owner (or master) only, checked per row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { inferPageType, isUpsellType, isDownsellType } from '@/lib/server/page-type-classifier';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

async function loadStepHtml(pageId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('page_html')
    .select('html')
    .eq('page_id', pageId)
    .eq('kind', 'cloned')
    .eq('variant', 'desktop')
    .maybeSingle();
  return typeof data?.html === 'string' ? data.html : '';
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getUserAccessContext(req);
    if (!ctx.userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string' && i) : [];
    if (ids.length === 0 || ids.length > 40) {
      return NextResponse.json(
        { error: 'invalid_body', message: 'Expected { ids: string[] } (1-40 row ids in funnel order)' },
        { status: 400 },
      );
    }

    const { data: rows, error: lookupErr } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, name, owner_user_id, steps')
      .in('id', ids);
    if (lookupErr) throw lookupErr;
    const byId = new Map((rows || []).map((r) => [r.id, r]));

    for (const id of ids) {
      const row = byId.get(id);
      if (!row) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
      if (row.owner_user_id !== ctx.userId && !ctx.isMaster) {
        return NextResponse.json({ error: 'forbidden', id }, { status: 403 });
      }
    }

    // Shared counters across the WHOLE sequence (folder of single-step rows
    // or steps inside one row) so upsell/downsell numbering is coherent.
    let upsellsSeen = 0;
    let downsellsSeen = 0;
    const results: Array<{ id: string; steps: Array<{ index: number; page_type: string }> }> = [];

    for (const id of ids) {
      const row = byId.get(id)!;
      const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
      const outSteps: Array<{ index: number; page_type: string }> = [];
      let changed = false;

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] || {};
        const cloned = (s.cloned_data || {}) as Record<string, unknown>;
        const pageId = typeof s.page_id === 'string' && s.page_id ? (s.page_id as string) : id;
        const html =
          (typeof cloned.html === 'string' && (cloned.html as string).length > 200
            ? (cloned.html as string)
            : '') || (await loadStepHtml(pageId));

        const inferred = inferPageType({
          url: String(s.url_to_swipe || cloned.source_url || ''),
          title: String(cloned.title || ''),
          name: String(s.name || row.name || ''),
          html,
          upsellsSeen,
          downsellsSeen,
        });
        if (isUpsellType(inferred)) upsellsSeen++;
        if (isDownsellType(inferred)) downsellsSeen++;

        if (String(s.page_type || '') !== inferred) {
          steps[i] = { ...s, page_type: inferred };
          changed = true;
        }
        outSteps.push({ index: i, page_type: inferred });
      }

      if (changed) {
        const { error: updErr } = await supabaseAdmin
          .from('archived_funnels')
          .update({ steps })
          .eq('id', id);
        if (updErr) throw updErr;
      }
      results.push({ id, steps: outSteps });
    }

    return NextResponse.json({ success: true, results });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
