// CRUD + html-fetch helpers for the Checkpoint library.
// The library = checkpoint_funnels table (user-added funnels).
// History = funnel_checkpoints table (runs).
//
// All functions are server-side only (use the supabase client + raw
// fetch). Keep this file thin — orchestration lives in the API routes.

import { supabase } from '@/lib/supabase';
import type {
  CheckpointFunnel,
  CheckpointRun,
  CreateCheckpointFunnelInput,
} from '@/types/checkpoint';

const SELECT_FUNNEL_FIELDS =
  'id,name,url,notes,brand_profile,product_type,project_id,' +
  'last_run_id,last_score_overall,last_run_status,last_run_at,' +
  'created_at,updated_at';

/** Read the whole library, newest first. */
export async function listFunnels(opts: {
  projectId?: string;
} = {}): Promise<CheckpointFunnel[]> {
  let q = supabase
    .from('checkpoint_funnels')
    .select(SELECT_FUNNEL_FIELDS)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);

  const { data, error } = await q;
  if (error) {
    console.warn(`[checkpoint-store] listFunnels: ${error.message}`);
    return [];
  }
  return (data as unknown as CheckpointFunnel[] | null) ?? [];
}

export async function getFunnel(
  id: string,
): Promise<CheckpointFunnel | null> {
  const { data, error } = await supabase
    .from('checkpoint_funnels')
    .select(SELECT_FUNNEL_FIELDS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn(`[checkpoint-store] getFunnel: ${error.message}`);
    return null;
  }
  return (data as unknown as CheckpointFunnel | null) ?? null;
}

/** Create a funnel. The `name` defaults to the URL hostname when
 *  the caller didn't supply one. */
export async function createFunnel(
  input: CreateCheckpointFunnelInput,
): Promise<CheckpointFunnel | { error: string }> {
  const url = (input.url ?? '').trim();
  if (!url) return { error: 'URL mancante.' };
  // Soft URL validation — accept any scheme but require a dot in the
  // host so we catch "asdfasdf" mistakes early.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (!parsedUrl.hostname.includes('.')) {
      return { error: 'URL non valido (manca il dominio).' };
    }
  } catch {
    return { error: 'URL non valido.' };
  }

  const finalUrl = parsedUrl.toString();
  const finalName =
    (input.name?.trim() && input.name.trim()) ||
    parsedUrl.hostname.replace(/^www\./, '');
  const productType = input.product_type ?? 'both';

  const { data, error } = await supabase
    .from('checkpoint_funnels')
    .insert({
      name: finalName,
      url: finalUrl,
      notes: input.notes?.trim() || null,
      brand_profile: input.brand_profile?.trim() || null,
      product_type: productType,
      project_id: input.project_id || null,
    })
    .select(SELECT_FUNNEL_FIELDS)
    .single();

  if (error || !data) {
    return { error: error?.message ?? 'Insert returned no row.' };
  }
  return data as unknown as CheckpointFunnel;
}

export async function deleteFunnel(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase
    .from('checkpoint_funnels')
    .delete()
    .eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

/** Update the denormalised "last run" snapshot on the parent funnel.
 *  Called by the run endpoint after a checkpoint completes. */
export async function syncLastRunSnapshot(args: {
  funnelId: string;
  runId: string;
  scoreOverall: number | null;
  status: string;
  ranAt: string;
}): Promise<void> {
  const { error } = await supabase
    .from('checkpoint_funnels')
    .update({
      last_run_id: args.runId,
      last_score_overall: args.scoreOverall,
      last_run_status: args.status,
      last_run_at: args.ranAt,
    })
    .eq('id', args.funnelId);
  if (error) {
    console.warn(`[checkpoint-store] syncLastRunSnapshot: ${error.message}`);
  }
}

/** History of runs for a funnel, newest first. */
export async function listRunsForFunnel(
  funnelId: string,
  limit = 20,
): Promise<CheckpointRun[]> {
  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .select('*')
    .eq('checkpoint_funnel_id', funnelId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn(`[checkpoint-store] listRunsForFunnel: ${error.message}`);
    return [];
  }
  return (data as unknown as CheckpointRun[] | null) ?? [];
}

/** Fetch the live HTML of a funnel's URL. Returns null when the URL
 *  doesn't respond or isn't reachable. */
export async function fetchFunnelHtml(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Wasabi Checkpoint Bot)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`[checkpoint-store] fetchFunnelHtml ${res.status} for ${url}`);
      return null;
    }
    const html = await res.text();
    if (!html || html.length < 200) return null;
    return html;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[checkpoint-store] fetchFunnelHtml error: ${msg}`);
    return null;
  }
}
