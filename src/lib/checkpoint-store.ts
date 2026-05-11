// CRUD + html-fetch helpers for the Checkpoint library.
// The library = checkpoint_funnels table (user-added funnels).
// History = funnel_checkpoints table (runs).
//
// All functions are server-side only (use the supabase client + raw
// fetch). Keep this file thin — orchestration lives in the API routes.

import { supabase } from '@/lib/supabase';
import type {
  CheckpointFunnel,
  CheckpointLogEntry,
  CheckpointRun,
  CheckpointRunStatus,
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

/**
 * Batch import multiple funnels (typically from a project's funnel
 * steps). Each item is validated like `createFunnel`. Items that are
 * either invalid or already present (same URL within the same project)
 * are returned in `skipped` instead of `created`, so the caller can
 * surface a clean "X imported, Y skipped" summary.
 */
export async function createFunnelsBatch(
  items: CreateCheckpointFunnelInput[],
): Promise<{
  created: CheckpointFunnel[];
  skipped: { input: CreateCheckpointFunnelInput; reason: string }[];
}> {
  const created: CheckpointFunnel[] = [];
  const skipped: { input: CreateCheckpointFunnelInput; reason: string }[] = [];

  // Pre-load existing URLs scoped per project so we can dedup before
  // hitting the DB (cheaper + clearer "skipped" reasons for the user).
  const projectIds = Array.from(
    new Set(items.map((i) => i.project_id).filter((p): p is string => !!p)),
  );
  const existingByProject = new Map<string, Set<string>>();
  if (projectIds.length > 0) {
    const { data, error } = await supabase
      .from('checkpoint_funnels')
      .select('project_id,url')
      .in('project_id', projectIds);
    if (!error && data) {
      for (const row of data as { project_id: string; url: string }[]) {
        if (!existingByProject.has(row.project_id)) {
          existingByProject.set(row.project_id, new Set());
        }
        existingByProject.get(row.project_id)!.add(row.url);
      }
    }
  }

  for (const item of items) {
    const trimmedUrl = (item.url ?? '').trim();
    if (!trimmedUrl) {
      skipped.push({ input: item, reason: 'URL mancante' });
      continue;
    }
    // Cheap dedup before round-tripping to the DB.
    if (item.project_id) {
      const existing = existingByProject.get(item.project_id);
      // Try both the raw URL and a normalised version so dups still
      // catch cases where the user typed the URL with/without trailing
      // slash etc. Normalisation logic mirrors createFunnel().
      let normalised: string | null = null;
      try {
        const u = new URL(
          trimmedUrl.startsWith('http') ? trimmedUrl : `https://${trimmedUrl}`,
        );
        normalised = u.toString();
      } catch {
        /* invalid URL — let createFunnel surface the proper error */
      }
      if (
        existing &&
        (existing.has(trimmedUrl) ||
          (normalised !== null && existing.has(normalised)))
      ) {
        skipped.push({ input: item, reason: 'già presente nel progetto' });
        continue;
      }
    }

    const result = await createFunnel(item);
    if ('error' in result) {
      skipped.push({ input: item, reason: result.error });
    } else {
      created.push(result);
      if (item.project_id) {
        if (!existingByProject.has(item.project_id)) {
          existingByProject.set(item.project_id, new Set());
        }
        existingByProject.get(item.project_id)!.add(result.url);
      }
    }
  }

  return { created, skipped };
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

/** Single run row. Used by the polling endpoint to surface
 *  partial-state updates while a run is in progress. */
export async function getRun(runId: string): Promise<CheckpointRun | null> {
  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (error) {
    console.warn(`[checkpoint-store] getRun: ${error.message}`);
    return null;
  }
  return (data as unknown as CheckpointRun | null) ?? null;
}

/** Most recent run for a funnel. Used right after the user clicks
 *  "Run" to discover the runId without needing the POST to return. */
export async function getLatestRunForFunnel(
  funnelId: string,
): Promise<CheckpointRun | null> {
  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .select('*')
    .eq('checkpoint_funnel_id', funnelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[checkpoint-store] getLatestRunForFunnel: ${error.message}`);
    return null;
  }
  return (data as unknown as CheckpointRun | null) ?? null;
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

/** Global "log" view across all funnels, newest first.
 *
 *  We keep the columns lean (no JSON results blob) because this feeds
 *  the Log modal, where the user only needs an at-a-glance summary
 *  (when, who, which funnel, score, status).
 */
export async function listRecentRuns(limit = 200): Promise<CheckpointLogEntry[]> {
  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .select(
      'id,checkpoint_funnel_id,funnel_name,funnel_url,' +
        'score_overall,status,triggered_by_user_id,triggered_by_name,' +
        'created_at,completed_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn(`[checkpoint-store] listRecentRuns: ${error.message}`);
    return [];
  }
  type Row = {
    id: string;
    checkpoint_funnel_id: string;
    funnel_name: string;
    funnel_url: string;
    score_overall: number | null;
    status: CheckpointRunStatus;
    triggered_by_user_id: string | null;
    triggered_by_name: string | null;
    created_at: string;
    completed_at: string | null;
  };
  const rows = (data as unknown as Row[] | null) ?? [];
  return rows.map((r) => ({
    ...r,
    duration_ms:
      r.completed_at && r.created_at
        ? new Date(r.completed_at).getTime() - new Date(r.created_at).getTime()
        : null,
  }));
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
