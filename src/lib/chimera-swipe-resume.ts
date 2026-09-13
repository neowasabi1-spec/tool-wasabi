/**
 * Resume a Chimera/Clone-Swipe run that lost its worker chain.
 * Netlify often never starts the next background invocation; this picks
 * the next texts or photos batch from funnel_pages and fires it.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PROJECT_FILES_BUCKET = 'project-files';
const STALE_MS = 40_000;
const KICK_LOCK_MS = 45_000;

type PageRow = {
  id: string;
  project_id?: string | null;
  product_id?: string | null;
  name?: string | null;
  page_type?: string | null;
  url_to_swipe?: string | null;
  swipe_status?: string | null;
  swipe_result?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  cloned_data?: Record<string, unknown> | null;
  swiped_data?: Record<string, unknown> | null;
};

type SwipePage = {
  funnelPageId: string;
  sourcePageId: string;
  sourceUrl: string;
  name: string;
  type: string;
  htmlUrl?: string;
};

const COPY_DONE =
  /texts rewritten|texts now on the page|copy rewritten|Photos start after|copy pass continues|waiting for ChatGPT|Copy done|ChatGPT photo|starting ChatGPT|copy loaded — ChatGPT|Queued /i;

function getSb(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Supabase env missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function siteBaseUrl(): string {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
}

function ageMs(row: PageRow): number {
  return Date.now() - new Date(String(row.updated_at || 0)).getTime();
}

function projectOf(row: PageRow): string {
  return String(row.project_id || row.product_id || '');
}

function asPages(rows: PageRow[]): SwipePage[] {
  return rows.map((r) => {
    const cloned = (r.cloned_data && typeof r.cloned_data === 'object' ? r.cloned_data : {}) as Record<string, unknown>;
    return {
      funnelPageId: r.id,
      sourcePageId: r.id,
      sourceUrl: String(r.url_to_swipe || ''),
      name: String(r.name || 'Step'),
      type: String(r.page_type || 'landing'),
      htmlUrl: typeof cloned.htmlUrl === 'string' ? cloned.htmlUrl : '',
    };
  });
}

function needsCopy(row: PageRow): boolean {
  if (row.swipe_status === 'completed' || row.swipe_status === 'failed') return false;
  return !COPY_DONE.test(String(row.swipe_result || ''));
}

function photoOffset(row: PageRow): number {
  const swiped = (row.swiped_data && typeof row.swiped_data === 'object' ? row.swiped_data : {}) as Record<string, unknown>;
  const stored = Number(swiped.imageOffset);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const result = String(row.swipe_result || '');
  const m = result.match(/ChatGPT photo (\d+)\//i);
  if (m && /replaced/i.test(result)) return Number(m[1]);
  if (m) return Math.max(0, Number(m[1]) - 1);
  const range = result.match(/ChatGPT photos (\d+)–(\d+)/i);
  if (range) return Number(range[2]);
  return 0;
}

function runMeta(rows: PageRow[]): { market: string; imageMode: 'internal' | 'affiliate' } {
  for (const r of rows) {
    const cloned = (r.cloned_data && typeof r.cloned_data === 'object' ? r.cloned_data : {}) as Record<string, unknown>;
    const run = cloned.chimeraRun && typeof cloned.chimeraRun === 'object'
      ? cloned.chimeraRun as Record<string, unknown>
      : null;
    if (run) {
      return {
        market: String(run.market || ''),
        imageMode: run.imageMode === 'affiliate' ? 'affiliate' : 'internal',
      };
    }
  }
  return { market: '', imageMode: 'internal' };
}

async function loadMainProductImageUrl(sb: SupabaseClient, projectId: string): Promise<string | null> {
  try {
    const { data } = await sb
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return null;
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    const { data: pub } = sb.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(main.file_path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}

async function fireWorker(payload: Record<string, unknown>): Promise<boolean> {
  const base = siteBaseUrl();
  if (!base) {
    console.warn('[swipe-resume] site URL missing');
    return false;
  }
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  try {
    const res = await fetch(`${base}/.netlify/functions/pipeline-swipe-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, secret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || res.status === 202) return true;
    console.warn('[swipe-resume] kick HTTP', res.status, (await res.text().catch(() => '')).slice(0, 200));
    return false;
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/abort|timeout/i.test(msg)) return true;
    console.warn('[swipe-resume] kick:', msg);
    return false;
  }
}

type ChimeraNext = {
  phase: 'texts' | 'photos';
  pageIndex: number;
  imageOffset: number;
  allPageIds?: string[];
  imageMode?: string;
  market?: string;
  needsKick?: boolean;
  kickLock?: string | null;
};

function readNext(rows: PageRow[]): ChimeraNext | null {
  for (const r of rows) {
    const swiped = (r.swiped_data && typeof r.swiped_data === 'object' ? r.swiped_data : {}) as Record<string, unknown>;
    const n = swiped.chimeraNext;
    if (n && typeof n === 'object' && typeof (n as ChimeraNext).pageIndex === 'number') {
      return n as ChimeraNext;
    }
  }
  return null;
}

export async function drainStalledSwipes(opts: {
  pageIds?: string[];
  projectId?: string;
  maxProjects?: number;
} = {}): Promise<{ kicked: number; detail: string[] }> {
  const sb = getSb();
  const detail: string[] = [];
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  let q = sb
    .from('funnel_pages')
    .select('id, project_id, product_id, name, page_type, url_to_swipe, swipe_status, swipe_result, updated_at, created_at, cloned_data, swiped_data')
    .eq('swipe_status', 'in_progress')
    .gte('updated_at', since)
    .order('created_at', { ascending: true })
    .limit(80);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  if (opts.pageIds?.length) q = q.in('id', opts.pageIds.slice(0, 40));
  const { data, error } = await q;
  if (error) {
    console.warn('[swipe-resume] query', error.message);
    return { kicked: 0, detail: [error.message] };
  }
  const rows = (data || []) as PageRow[];
  if (!rows.length) return { kicked: 0, detail };

  const byProject = new Map<string, PageRow[]>();
  for (const row of rows) {
    const pid = projectOf(row);
    if (!pid) continue;
    const list = byProject.get(pid) || [];
    list.push(row);
    byProject.set(pid, list);
  }

  let kicked = 0;
  const maxProjects = opts.maxProjects ?? 3;
  for (const [projectId, group] of byProject) {
    if (kicked >= maxProjects) break;
    const queued = readNext(group);
    const kickLocked = queued?.kickLock && Date.now() - Date.parse(queued.kickLock) < KICK_LOCK_MS;
    const workerLive = group.some((r) => ageMs(r) < STALE_MS) && !queued?.needsKick;
    if (kickLocked || workerLive) continue;

    const created0 = Date.parse(String(group[0].created_at || '')) || Date.now();
    const { data: extra } = await sb
      .from('funnel_pages')
      .select('id, project_id, product_id, name, page_type, url_to_swipe, swipe_status, swipe_result, updated_at, created_at, cloned_data, swiped_data')
      .or(`project_id.eq.${projectId},product_id.eq.${projectId}`)
      .in('swipe_status', ['in_progress', 'completed'])
      .gte('created_at', new Date(created0 - 180_000).toISOString())
      .order('created_at', { ascending: true })
      .limit(40);
    let all = ((extra || []) as PageRow[]).length ? extra as PageRow[] : group;
    if (queued?.allPageIds?.length) {
      const { data: named } = await sb
        .from('funnel_pages')
        .select('id, project_id, product_id, name, page_type, url_to_swipe, swipe_status, swipe_result, updated_at, created_at, cloned_data, swiped_data')
        .in('id', queued.allPageIds.slice(0, 40));
      if (named?.length) {
        const byId = new Map((named as PageRow[]).map((r) => [r.id, r]));
        all = queued.allPageIds.map((id) => byId.get(id)).filter(Boolean) as PageRow[];
      }
    }
    const pages = asPages(all);
    if (!pages.length) continue;

    const textIdx = all.findIndex(needsCopy);
    const photoIdx = all.findIndex((r) => r.swipe_status === 'in_progress' && COPY_DONE.test(String(r.swipe_result || '')));
    const meta = runMeta(all);
    const mainImageUrl = await loadMainProductImageUrl(sb, projectId);

    let phase: 'texts' | 'photos' = queued?.phase || 'photos';
    let pageIndex = queued ? queued.pageIndex : 0;
    let imageOffset = queued ? queued.imageOffset : 0;
    if (!queued?.needsKick) {
      if (textIdx >= 0) {
        phase = 'texts';
        pageIndex = textIdx;
        imageOffset = 0;
      } else if (photoIdx >= 0) {
        phase = 'photos';
        pageIndex = photoIdx;
        imageOffset = photoOffset(all[photoIdx]);
      } else {
        continue;
      }
    }
    pageIndex = Math.min(Math.max(0, pageIndex), pages.length - 1);

    const label = phase === 'texts'
      ? `Resuming copy on step ${pageIndex + 1}/${pages.length}…`
      : `Resuming ChatGPT photos on step ${pageIndex + 1}/${pages.length} from ${imageOffset + 1}…`;
    const lockAt = new Date().toISOString();
    for (const r of group) {
      const prev = (r.swiped_data && typeof r.swiped_data === 'object' ? r.swiped_data : {}) as Record<string, unknown>;
      const n = (prev.chimeraNext && typeof r.swiped_data === 'object' ? prev.chimeraNext : queued) || {};
      await sb.from('funnel_pages').update({
        swipe_status: 'in_progress',
        swipe_result: label,
        swiped_data: { ...prev, chimeraNext: { ...(typeof n === 'object' && n ? n : {}), phase, pageIndex, imageOffset, needsKick: true, kickLock: lockAt } },
        updated_at: lockAt,
      }).eq('id', r.id);
    }

    const ok = await fireWorker({
      projectId,
      market: String(queued?.market || meta.market || ''),
      mainImageUrl,
      imageMode: queued?.imageMode === 'affiliate' || meta.imageMode === 'affiliate' ? 'affiliate' : 'internal',
      phase,
      skipTexts: phase === 'photos',
      pages,
      allPages: pages,
      pageIndex,
      imageOffset,
    });
    detail.push(`${projectId} ${phase} step ${pageIndex + 1} offset=${imageOffset} ${ok ? 'ok' : 'fail'}`);
    if (ok) kicked += 1;
  }

  return { kicked, detail };
}
