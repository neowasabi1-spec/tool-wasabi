// CRUD + html-fetch helpers for the Checkpoint library.
// The library = checkpoint_funnels table (user-added funnels).
// History = funnel_checkpoints table (runs).
//
// All functions are server-side only (use the supabase client + raw
// fetch). Keep this file thin — orchestration lives in the API routes.

import { supabase } from '@/lib/supabase';
import { fetchHtmlSmart } from '@/lib/fetch-html-smart';
import {
  captureMobileScreenshot,
  uploadCheckpointScreenshot,
} from '@/lib/screenshot-capture';
import type {
  CheckpointFunnel,
  CheckpointFunnelPage,
  CheckpointLogEntry,
  CheckpointRun,
  CheckpointRunStatus,
  CreateCheckpointFunnelInput,
} from '@/types/checkpoint';

const SELECT_FUNNEL_FIELDS =
  'id,name,url,pages,notes,brand_profile,product_type,project_id,' +
  'last_run_id,last_score_overall,last_run_status,last_run_at,' +
  'created_at,updated_at';

const MAX_PAGES_PER_FUNNEL = 100;

/** Normalise + validate a single page entry. */
function normalisePage(input: {
  url?: string;
  name?: string;
  pageType?: string;
  screenshotUrl?: string | null;
}):
  | { ok: true; page: CheckpointFunnelPage }
  | { ok: false; error: string } {
  const raw = (input.url ?? '').trim();
  if (!raw) return { ok: false, error: 'URL mancante.' };
  let parsed: URL;
  try {
    parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (!parsed.hostname.includes('.')) {
      return { ok: false, error: `URL non valido (manca il dominio): ${raw}` };
    }
  } catch {
    return { ok: false, error: `URL non valido: ${raw}` };
  }
  return {
    ok: true,
    page: {
      url: parsed.toString(),
      name: input.name?.trim() || undefined,
      pageType: input.pageType?.trim() || undefined,
      screenshotUrl: input.screenshotUrl?.trim() || undefined,
    },
  };
}

/** Resolve the input (single url OR pages[]) into a normalised
 *  ordered list of pages. Source of truth for createFunnel. */
function resolvePagesFromInput(
  input: CreateCheckpointFunnelInput,
):
  | { ok: true; pages: CheckpointFunnelPage[] }
  | { ok: false; error: string } {
  const raw: {
    url?: string;
    name?: string;
    pageType?: string;
    screenshotUrl?: string | null;
  }[] = [];
  // Funnel-level fallback type (e.g. "landing" picked once for a
  // single-page Landing entry). Per-page values still win.
  const defaultType = input.page_type?.trim() || undefined;
  if (input.pages && Array.isArray(input.pages) && input.pages.length > 0) {
    for (const p of input.pages) {
      raw.push({
        url: p.url,
        name: p.name,
        pageType: p.pageType ?? defaultType,
        screenshotUrl: p.screenshotUrl,
      });
    }
  } else if (input.url) {
    raw.push({ url: input.url, name: input.name, pageType: defaultType });
  } else {
    return { ok: false, error: 'Nessuna URL fornita.' };
  }
  if (raw.length > MAX_PAGES_PER_FUNNEL) {
    return {
      ok: false,
      error: `Massimo ${MAX_PAGES_PER_FUNNEL} pagine per funnel (ne hai passate ${raw.length}).`,
    };
  }
  const out: CheckpointFunnelPage[] = [];
  for (const entry of raw) {
    const r = normalisePage(entry);
    if (!r.ok) return { ok: false, error: r.error };
    out.push(r.page);
  }
  return { ok: true, pages: out };
}

/** Coerce a row coming from Supabase into a fully-typed CheckpointFunnel.
 *  Older rows (pre-v2) have empty pages[]; we synthesise pages = [{url}]
 *  so downstream code can always rely on pages[] being populated. */
function rowToFunnel(row: Record<string, unknown>): CheckpointFunnel {
  const rawPages = row.pages as unknown;
  let pages: CheckpointFunnelPage[] = [];
  if (Array.isArray(rawPages) && rawPages.length > 0) {
    pages = (rawPages as CheckpointFunnelPage[])
      .map((p) => ({
        url: typeof p?.url === 'string' ? p.url : '',
        name: typeof p?.name === 'string' ? p.name : undefined,
        pageType:
          typeof p?.pageType === 'string' && p.pageType.trim()
            ? p.pageType
            : undefined,
      }))
      .filter((p) => p.url);
  }
  if (pages.length === 0 && typeof row.url === 'string' && row.url) {
    pages = [{ url: row.url, name: (row.name as string) || undefined }];
  }
  return { ...(row as unknown as CheckpointFunnel), pages };
}

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
  const rows = (data as unknown as Record<string, unknown>[] | null) ?? [];
  return rows.map(rowToFunnel);
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
  if (!data) return null;
  return rowToFunnel(data as unknown as Record<string, unknown>);
}

/** Create a funnel — accepts either single-url or multi-page input.
 *
 *  Storage rule: pages[] is the source of truth (JSONB array). The
 *  legacy `url` column is mirrored to pages[0].url so old code paths
 *  that still read `url` keep working.
 *
 *  The `name` defaults to the first URL's hostname when not supplied.
 */
export async function createFunnel(
  input: CreateCheckpointFunnelInput,
): Promise<CheckpointFunnel | { error: string }> {
  const resolved = resolvePagesFromInput(input);
  if (!resolved.ok) return { error: resolved.error };
  const pages = resolved.pages;
  const firstUrl = pages[0].url;
  const firstHost = (() => {
    try {
      return new URL(firstUrl).hostname.replace(/^www\./, '');
    } catch {
      return firstUrl;
    }
  })();
  const finalName =
    (input.name?.trim() && input.name.trim()) ||
    (pages.length > 1 ? `${firstHost} (${pages.length} step)` : firstHost);
  const productType = input.product_type ?? 'both';

  const { data, error } = await supabase
    .from('checkpoint_funnels')
    .insert({
      name: finalName,
      url: firstUrl,
      pages: pages,
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
  return rowToFunnel(data as unknown as Record<string, unknown>);
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

/** A run is considered "stale" (= the worker lambda died mid-flight)
 *  when it stayed in `running` for longer than this. After that we
 *  flip it to `failed` so the polling UI can stop spinning forever.
 *  Tuned to comfortably exceed the slowest legitimate run (multi-step
 *  funnel with Playwright cold starts) but well under "user already
 *  gave up". */
const RUN_STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

/** If `row` is a `running` checkpoint older than the stale threshold,
 *  flip it to `failed` in-place (both in the DB and on the returned
 *  object). This prevents the live dashboard from spinning forever
 *  when the serverless function gets killed mid-run by the platform
 *  (Netlify free tier 10s, Pro 26s/300s, etc.). */
async function reapStaleRun(
  row: CheckpointRun | null,
): Promise<CheckpointRun | null> {
  if (!row) return row;
  if (row.status !== 'running') return row;
  const startedAt = new Date(row.started_at ?? row.created_at).getTime();
  if (!Number.isFinite(startedAt)) return row;
  if (Date.now() - startedAt < RUN_STALE_AFTER_MS) return row;

  const completedAt = new Date().toISOString();
  const errorMsg =
    'Run interrotta dal server (timeout della funzione). Riprova: il fetch delle pagine ora gira in parallelo, ma una run molto lunga può ancora superare il limite della piattaforma.';
  const { error } = await supabase
    .from('funnel_checkpoints')
    .update({
      status: 'failed' as CheckpointRunStatus,
      error: errorMsg,
      completed_at: completedAt,
    })
    .eq('id', row.id)
    .eq('status', 'running'); // CAS-like: don't clobber a row that just finished
  if (error) {
    console.warn(`[checkpoint-store] reapStaleRun: ${error.message}`);
    return row;
  }
  return {
    ...row,
    status: 'failed' as CheckpointRunStatus,
    error: errorMsg,
    completed_at: completedAt,
  };
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
  return reapStaleRun((data as unknown as CheckpointRun | null) ?? null);
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
  return reapStaleRun((data as unknown as CheckpointRun | null) ?? null);
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

/** Fetch the live HTML of a single funnel page. Returns null when
 *  the URL doesn't respond. Uses fetchHtmlSmart so SPAs are rendered
 *  via Playwright before the AI audit runs. */
export async function fetchFunnelHtml(url: string): Promise<string | null> {
  if (!url) return null;
  const fetched = await fetchHtmlSmart(url, {
    mode: 'full',
    fetchTimeoutMs: 20000,
    playwrightTimeoutMs: 30000,
    userAgent: 'Mozilla/5.0 (Wasabi Checkpoint Bot)',
  });
  if (!fetched.ok || !fetched.html || fetched.html.length < 200) {
    console.warn(
      `[checkpoint-store] fetchFunnelHtml failed for ${url}: ${fetched.error ?? 'too short'} (attempts: ${fetched.attempts.join(' | ')})`,
    );
    return null;
  }
  if (fetched.wasSpa) {
    console.log(
      `[checkpoint-store] fetchFunnelHtml: SPA rendered via ${fetched.source} for ${url} (${fetched.html.length} chars, ${fetched.durationMs}ms)`,
    );
  }
  return fetched.html;
}

/** v2: fetch HTML for ALL pages of a multi-step funnel.
 *  Returns one entry per page (in input order), with html=null when
 *  that specific page failed (so the caller can decide whether to
 *  abort or continue).
 *
 *  Pages are fetched in PARALLEL with bounded concurrency. Sequential
 *  fetching used to put the whole run over Netlify's function timeout
 *  on funnels with >5 steps (each Playwright render can take 15-30s).
 *  Concurrency is capped to avoid exhausting Lambda memory — Playwright
 *  spawns one Chromium instance per concurrent fetch.
 */
export interface FunnelPageHtml {
  index: number;
  url: string;
  name?: string;
  /** Page-type tag carried over from CheckpointFunnelPage so the
   *  audit prompt can label each step (advertorial / vsl / landing
   *  / checkout / ...). Undefined when the funnel was created before
   *  pageType was a thing or when the user didn't pick one. */
  pageType?: string;
  html: string | null;
  htmlLength: number;
  error: string | null;
  /** Public URL of the mobile screenshot uploaded to Supabase Storage,
   *  populated only when fetchFunnelPagesHtml is called with
   *  `withScreenshots: true` AND the capture succeeded. Used by the
   *  Visual audit to feed Claude vision via URL image blocks. */
  screenshotMobileUrl?: string | null;
  /** Captured-but-not-yet-uploaded byte size, for diagnostics. */
  screenshotBytes?: number;
  /** Per-step screenshot error (capture or upload). Null when ok or
   *  when screenshots weren't requested. */
  screenshotError?: string | null;
}

const FETCH_CONCURRENCY = 3;
/** Cap on parallel screenshot captures. Each Playwright launch costs
 *  ~5–10s of cold start + 200–500MB peak memory, so we keep this
 *  smaller than the HTML fetch concurrency. */
const SCREENSHOT_CONCURRENCY = 2;

export interface FetchFunnelPagesOptions {
  /** Capture mobile screenshots and upload them to Supabase Storage.
   *  Required when `runId` is provided. */
  withScreenshots?: boolean;
  /** Run id used as the storage path prefix (`{runId}/step-N-mobile.jpg`).
   *  Required when `withScreenshots` is true. */
  runId?: string;
  /** Cap on number of pages we screenshot — extra pages return without
   *  a screenshot (still get HTML). Defaults to 12 to match the cap on
   *  images we ship to Claude per request. */
  maxScreenshots?: number;
  /** Optional progress callback invoked at each macro stage of the
   *  prep pipeline (HTML fetch start/finish, screenshot start/finish).
   *  The /run route uses this to write a "stage hint" into
   *  funnel_checkpoints.error so the polling client can show the user
   *  WHAT we're doing during the ~30-90s before any category lands.
   *  Errors thrown by the callback are swallowed — progress reporting
   *  must never break the audit. */
  onStage?: (stage: string) => Promise<void> | void;
}

export async function fetchFunnelPagesHtml(
  pages: CheckpointFunnelPage[],
  opts: FetchFunnelPagesOptions = {},
): Promise<FunnelPageHtml[]> {
  const safeStage = async (msg: string) => {
    if (!opts.onStage) return;
    try {
      await opts.onStage(msg);
    } catch (err) {
      console.warn('[checkpoint-store] onStage callback threw:', err);
    }
  };

  const out: FunnelPageHtml[] = new Array(pages.length);
  let cursor = 0;
  let fetched = 0;

  await safeStage(
    `Scarico ${pages.length} ${pages.length === 1 ? 'pagina' : 'pagine'} del funnel…`,
  );

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= pages.length) return;
      const p = pages[i];
      try {
        const html = await fetchFunnelHtml(p.url);
        out[i] = {
          index: i,
          url: p.url,
          name: p.name,
          pageType: p.pageType,
          html,
          htmlLength: html?.length ?? 0,
          error: html ? null : 'fetch returned null',
        };
      } catch (err) {
        out[i] = {
          index: i,
          url: p.url,
          name: p.name,
          pageType: p.pageType,
          html: null,
          htmlLength: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      fetched++;
      // Report progress every page to keep the user's "is it stuck?"
      // anxiety in check.
      await safeStage(`Pagine scaricate ${fetched}/${pages.length}`);
    }
  }

  const workerCount = Math.min(FETCH_CONCURRENCY, pages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Optional second pass: capture mobile screenshots for the (still
  // reachable) pages and upload them to Supabase Storage. Done AFTER
  // the HTML fetch so we can skip pages that didn't load at all.
  if (opts.withScreenshots) {
    if (!opts.runId) {
      console.warn(
        '[checkpoint-store] withScreenshots=true but no runId provided — skipping screenshot capture.',
      );
    } else {
      await captureAndUploadScreenshots(out, {
        runId: opts.runId,
        maxScreenshots: opts.maxScreenshots ?? 12,
        onStage: opts.onStage,
      });
    }
  }

  return out;
}

/** Capture + upload pipeline. Mutates `pages` in place to attach
 *  `screenshotMobileUrl` / `screenshotError`. Pages without HTML are
 *  skipped (no point screenshotting an unreachable URL). Pages past
 *  the `maxScreenshots` cap are skipped silently. */
async function captureAndUploadScreenshots(
  pages: FunnelPageHtml[],
  opts: {
    runId: string;
    maxScreenshots: number;
    onStage?: (stage: string) => Promise<void> | void;
  },
): Promise<void> {
  const safeStage = async (msg: string) => {
    if (!opts.onStage) return;
    try {
      await opts.onStage(msg);
    } catch (err) {
      console.warn('[checkpoint-store] onStage(screenshot) threw:', err);
    }
  };

  const eligibleIdx = pages
    .filter((p) => p.html && p.html.length > 0)
    .slice(0, opts.maxScreenshots)
    .map((p) => pages.indexOf(p));

  if (eligibleIdx.length === 0) {
    console.log('[checkpoint-store] no eligible pages for screenshot capture');
    return;
  }

  console.log(
    `[checkpoint-store] capturing ${eligibleIdx.length}/${pages.length} screenshots (runId=${opts.runId}, concurrency=${SCREENSHOT_CONCURRENCY})`,
  );
  await safeStage(
    `Cattura screenshot mobili (0/${eligibleIdx.length})…`,
  );

  let cursor = 0;
  let captured = 0;
  async function worker(): Promise<void> {
    while (true) {
      const k = cursor++;
      if (k >= eligibleIdx.length) return;
      const i = eligibleIdx[k];
      const page = pages[i];
      try {
        const shot = await captureMobileScreenshot(page.url);
        if (!shot.ok || !shot.buffer) {
          page.screenshotMobileUrl = null;
          page.screenshotError = shot.error ?? 'capture failed';
          continue;
        }
        const upload = await uploadCheckpointScreenshot({
          runId: opts.runId,
          stepIndex: page.index + 1,
          buffer: shot.buffer,
          viewport: 'mobile',
        });
        if (!upload.ok) {
          page.screenshotMobileUrl = null;
          page.screenshotBytes = shot.buffer.length;
          page.screenshotError = upload.error ?? 'upload failed';
        } else {
          page.screenshotMobileUrl = upload.publicUrl;
          page.screenshotBytes = shot.buffer.length;
          page.screenshotError = null;
        }
      } catch (err) {
        page.screenshotMobileUrl = null;
        page.screenshotError =
          err instanceof Error ? err.message : String(err);
      }
      captured++;
      await safeStage(
        `Cattura screenshot mobili (${captured}/${eligibleIdx.length})…`,
      );
    }
  }

  const workerCount = Math.min(SCREENSHOT_CONCURRENCY, eligibleIdx.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const ok = pages.filter((p) => p.screenshotMobileUrl).length;
  const failed = pages.filter(
    (p) => p.screenshotError && !p.screenshotMobileUrl,
  ).length;
  console.log(
    `[checkpoint-store] screenshot capture done — ok=${ok} failed=${failed}`,
  );
}
