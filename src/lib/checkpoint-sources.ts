// Unifies funnel rows from the 3 source tables into a single
// UnifiedFunnel[] used by the /checkpoint dashboard. Lives in a
// dedicated module so the API route stays thin and the same loader
// can be reused from server actions / scripts.
//
// Source tables today (extend by adding a fetcher + a mapper):
//   - funnel_pages         (front-end product pages)
//   - post_purchase_pages  (upsell / thank-you)
//   - archived_funnels     (multi-step funnels archived from My Archive)

import { supabase } from '@/lib/supabase';
import type {
  CheckpointSourceTable,
  CheckpointRun,
  UnifiedFunnel,
} from '@/types/checkpoint';

interface FunnelPagesRow {
  id: string;
  name: string;
  url_to_swipe: string;
  swipe_status: string | null;
  swiped_data: unknown;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PostPurchasePagesRow {
  id: string;
  name: string;
  url_to_swipe: string;
  swipe_status: string | null;
  swiped_data: unknown;
  created_at: string;
  updated_at: string;
}

interface ArchivedFunnelsRow {
  id: string;
  name: string;
  total_steps: number;
  steps: unknown;
  section: string | null;
  project_id: string | null;
  created_at: string;
}

interface ArchivedStep {
  url?: string;
  swipe_status?: string;
  swiped_data?: unknown;
}

/** True when the JSONB swipe payload looks "non-empty". Defensive: the
 *  shape varies across the codebase (string, object with html, etc.). */
function hasSwipedPayload(swiped: unknown): boolean {
  if (!swiped) return false;
  if (typeof swiped === 'string') return swiped.length > 50;
  if (typeof swiped === 'object') {
    const obj = swiped as Record<string, unknown>;
    if (typeof obj.html === 'string' && obj.html.length > 50) return true;
    if (typeof obj.htmlPreview === 'string' && obj.htmlPreview.length > 50)
      return true;
    return Object.keys(obj).length > 0;
  }
  return false;
}

function mapFunnelPagesRow(row: FunnelPagesRow): UnifiedFunnel {
  return {
    id: `funnel_pages:${row.id}`,
    source_table: 'funnel_pages',
    source_id: row.id,
    name: row.name || 'Untitled funnel page',
    url: row.url_to_swipe || '',
    was_swiped: hasSwipedPayload(row.swiped_data),
    swipe_status: row.swipe_status,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapPostPurchaseRow(row: PostPurchasePagesRow): UnifiedFunnel {
  return {
    id: `post_purchase_pages:${row.id}`,
    source_table: 'post_purchase_pages',
    source_id: row.id,
    name: row.name || 'Untitled post-purchase page',
    url: row.url_to_swipe || '',
    was_swiped: hasSwipedPayload(row.swiped_data),
    swipe_status: row.swipe_status,
    // post_purchase_pages doesn't carry project_id today.
    project_id: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapArchivedFunnelRow(row: ArchivedFunnelsRow): UnifiedFunnel {
  // archived_funnels.steps is a JSONB array — pick the entry URL from
  // step 0 and aggregate swipe state across all steps. Only counts as
  // "swiped" if at least one step has a swipe payload.
  const steps = Array.isArray(row.steps) ? (row.steps as ArchivedStep[]) : [];
  const firstUrl = steps[0]?.url ?? '';
  const wasSwiped = steps.some((s) => hasSwipedPayload(s?.swiped_data));
  // Derive an aggregate swipe status: completed if ALL steps have a
  // payload, in_progress if some, pending otherwise.
  let swipeStatus: string | null = 'pending';
  if (steps.length > 0) {
    const swipedCount = steps.filter((s) =>
      hasSwipedPayload(s?.swiped_data),
    ).length;
    if (swipedCount === steps.length) swipeStatus = 'completed';
    else if (swipedCount > 0) swipeStatus = 'in_progress';
  }
  return {
    id: `archived_funnels:${row.id}`,
    source_table: 'archived_funnels',
    source_id: row.id,
    name: row.name || 'Untitled archived funnel',
    url: firstUrl,
    was_swiped: wasSwiped,
    swipe_status: swipeStatus,
    project_id: row.project_id,
    created_at: row.created_at,
    // archived_funnels has no updated_at column — fall back to created_at.
    updated_at: row.created_at,
  };
}

interface LoadOptions {
  /** Restrict to specific source tables. Default = all three. */
  sources?: CheckpointSourceTable[];
  /** Filter by project. */
  projectId?: string;
  /** Limit per source (defaults to 100 each — total cap 300). */
  perSourceLimit?: number;
}

/** Reads source tables in parallel, normalises and merges them. */
export async function loadUnifiedFunnels(
  opts: LoadOptions = {},
): Promise<UnifiedFunnel[]> {
  const sources: CheckpointSourceTable[] =
    opts.sources && opts.sources.length > 0
      ? opts.sources
      : ['funnel_pages', 'post_purchase_pages', 'archived_funnels'];
  const limit = opts.perSourceLimit ?? 100;

  // Each source loader is wrapped in an async IIFE so we get a real
  // Promise<UnifiedFunnel[]> (Supabase's query builder returns
  // PromiseLike, which Promise.all doesn't accept directly).
  const tasks: Promise<UnifiedFunnel[]>[] = [];

  if (sources.includes('funnel_pages')) {
    tasks.push(
      (async (): Promise<UnifiedFunnel[]> => {
        let q = supabase
          .from('funnel_pages')
          .select(
            'id,name,url_to_swipe,swipe_status,swiped_data,project_id,created_at,updated_at',
          )
          .order('updated_at', { ascending: false })
          .limit(limit);
        if (opts.projectId) q = q.eq('project_id', opts.projectId);
        const { data, error } = await q;
        if (error) {
          console.warn(`[checkpoint-sources] funnel_pages: ${error.message}`);
          return [];
        }
        return (data as FunnelPagesRow[] | null)?.map(mapFunnelPagesRow) ?? [];
      })(),
    );
  }

  if (sources.includes('post_purchase_pages')) {
    tasks.push(
      (async (): Promise<UnifiedFunnel[]> => {
        const { data, error } = await supabase
          .from('post_purchase_pages')
          .select(
            'id,name,url_to_swipe,swipe_status,swiped_data,created_at,updated_at',
          )
          .order('updated_at', { ascending: false })
          .limit(limit);
        if (error) {
          console.warn(
            `[checkpoint-sources] post_purchase_pages: ${error.message}`,
          );
          return [];
        }
        return (
          (data as PostPurchasePagesRow[] | null)?.map(mapPostPurchaseRow) ?? []
        );
      })(),
    );
  }

  if (sources.includes('archived_funnels')) {
    tasks.push(
      (async (): Promise<UnifiedFunnel[]> => {
        let q = supabase
          .from('archived_funnels')
          .select('id,name,total_steps,steps,section,project_id,created_at')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (opts.projectId) q = q.eq('project_id', opts.projectId);
        const { data, error } = await q;
        if (error) {
          console.warn(
            `[checkpoint-sources] archived_funnels: ${error.message}`,
          );
          return [];
        }
        return (
          (data as ArchivedFunnelsRow[] | null)?.map(mapArchivedFunnelRow) ?? []
        );
      })(),
    );
  }

  const results = await Promise.all(tasks);
  const merged = results.flat();
  // Sort by updated_at desc so the freshest funnel sits on top
  // regardless of which table it came from.
  merged.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return merged;
}

/** Fetch the most recent checkpoint per (source_table, source_id) and
 *  attach as `last_checkpoint` to each UnifiedFunnel. */
export async function attachLastCheckpoint(
  funnels: UnifiedFunnel[],
): Promise<UnifiedFunnel[]> {
  if (funnels.length === 0) return funnels;
  const sourceIds = funnels.map((f) => f.source_id);

  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .select(
      'id,source_table,source_id,status,score_overall,completed_at,created_at',
    )
    .in('source_id', sourceIds)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn(`[checkpoint-sources] funnel_checkpoints: ${error.message}`);
    return funnels;
  }

  // Bucket by composite key, keep first (= most recent because of
  // the order-by above).
  const lastByKey = new Map<string, CheckpointRun>();
  for (const row of (data as Partial<CheckpointRun>[] | null) ?? []) {
    if (!row.source_table || !row.source_id) continue;
    const key = `${row.source_table}:${row.source_id}`;
    if (!lastByKey.has(key)) {
      lastByKey.set(key, row as CheckpointRun);
    }
  }

  return funnels.map((f) => {
    const last = lastByKey.get(f.id);
    return {
      ...f,
      last_checkpoint: last
        ? {
            id: last.id,
            status: last.status,
            score_overall: last.score_overall,
            completed_at: last.completed_at,
            created_at: last.created_at,
          }
        : null,
    };
  });
}

/** Resolve a single UnifiedFunnel by composite ID `${table}:${id}`. */
export async function loadFunnelById(
  compositeId: string,
): Promise<UnifiedFunnel | null> {
  const sepIdx = compositeId.indexOf(':');
  if (sepIdx < 0) return null;
  const table = compositeId.slice(0, sepIdx) as CheckpointSourceTable;
  const id = compositeId.slice(sepIdx + 1);

  if (table === 'funnel_pages') {
    const { data, error } = await supabase
      .from('funnel_pages')
      .select(
        'id,name,url_to_swipe,swipe_status,swiped_data,project_id,created_at,updated_at',
      )
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return mapFunnelPagesRow(data as FunnelPagesRow);
  }
  if (table === 'post_purchase_pages') {
    const { data, error } = await supabase
      .from('post_purchase_pages')
      .select('id,name,url_to_swipe,swipe_status,swiped_data,created_at,updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return mapPostPurchaseRow(data as PostPurchasePagesRow);
  }
  if (table === 'archived_funnels') {
    const { data, error } = await supabase
      .from('archived_funnels')
      .select('id,name,total_steps,steps,section,project_id,created_at')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return mapArchivedFunnelRow(data as ArchivedFunnelsRow);
  }
  return null;
}

/**
 * Pull the actual HTML to analyze for a given UnifiedFunnel.
 * Order of preference: swiped_data.html > cloned_data.html > fetch(url).
 * Returns null if nothing usable exists.
 *
 * For `archived_funnels` we currently use step 0 — multi-step audit is a
 * later enhancement.
 */
export async function loadFunnelHtml(
  funnel: UnifiedFunnel,
): Promise<{ html: string; source: 'swiped' | 'cloned' | 'fetch' } | null> {
  const fetchHtml = async (): Promise<string | null> => {
    if (!funnel.url) return null;
    try {
      const res = await fetch(funnel.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Wasabi Checkpoint Bot)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  if (funnel.source_table === 'funnel_pages') {
    const { data } = await supabase
      .from('funnel_pages')
      .select('cloned_data,swiped_data')
      .eq('id', funnel.source_id)
      .maybeSingle();
    const swiped = (data?.swiped_data ?? null) as { html?: string } | null;
    if (swiped?.html && swiped.html.length > 100) {
      return { html: swiped.html, source: 'swiped' };
    }
    const cloned = (data?.cloned_data ?? null) as { html?: string } | null;
    if (cloned?.html && cloned.html.length > 100) {
      return { html: cloned.html, source: 'cloned' };
    }
  } else if (funnel.source_table === 'post_purchase_pages') {
    const { data } = await supabase
      .from('post_purchase_pages')
      .select('cloned_data,swiped_data')
      .eq('id', funnel.source_id)
      .maybeSingle();
    const swiped = (data?.swiped_data ?? null) as { html?: string } | null;
    if (swiped?.html && swiped.html.length > 100) {
      return { html: swiped.html, source: 'swiped' };
    }
    const cloned = (data?.cloned_data ?? null) as { html?: string } | null;
    if (cloned?.html && cloned.html.length > 100) {
      return { html: cloned.html, source: 'cloned' };
    }
  } else if (funnel.source_table === 'archived_funnels') {
    const { data } = await supabase
      .from('archived_funnels')
      .select('steps')
      .eq('id', funnel.source_id)
      .maybeSingle();
    const steps = Array.isArray(data?.steps)
      ? (data.steps as Array<{ swiped_data?: { html?: string }; cloned_data?: { html?: string } }>)
      : [];
    const step0 = steps[0];
    if (step0?.swiped_data?.html && step0.swiped_data.html.length > 100) {
      return { html: step0.swiped_data.html, source: 'swiped' };
    }
    if (step0?.cloned_data?.html && step0.cloned_data.html.length > 100) {
      return { html: step0.cloned_data.html, source: 'cloned' };
    }
  }

  const live = await fetchHtml();
  if (live) return { html: live, source: 'fetch' };
  return null;
}
