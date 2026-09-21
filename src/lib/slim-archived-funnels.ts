/**
 * Read archived_funnels without shipping cloned_data.html to the browser.
 * Screenshots stay on each step so Template / Clone-Swipe cards still render.
 */

import { supabaseAdmin } from './supabase-admin';

export type SlimArchiveStep = {
  name?: string;
  page_type?: string;
  step_type?: string;
  page_id?: string;
  step_index?: number;
  url_to_swipe?: string;
  prompt?: string;
  cloned_data?: {
    source_url?: string;
    screenshotDesktopUrl?: string | null;
    screenshotMobileUrl?: string | null;
    htmlUrl?: string;
    category?: string;
    tags?: string[];
    geo?: string;
  };
};

export type SlimArchiveRow = {
  id: string;
  name: string;
  created_at: string;
  total_steps?: number | null;
  project_id?: string | null;
  section?: string | null;
  steps: SlimArchiveStep[];
};

const CREATE_SLIM_FN = `
CREATE OR REPLACE FUNCTION public.slim_archived_funnels(p_project_id uuid DEFAULT NULL, p_limit int DEFAULT 400)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  total_steps int,
  project_id uuid,
  section text,
  steps jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
SET statement_timeout TO '30s'
AS $$
  SELECT
    f.id,
    f.name,
    f.created_at,
    f.total_steps,
    f.project_id,
    f.section,
    COALESCE((
      SELECT jsonb_agg(s.step ORDER BY s.ord)
      FROM (
        SELECT
          e.ord,
          jsonb_build_object(
            'name', e.elem->>'name',
            'page_type', COALESCE(e.elem->>'page_type', e.elem->>'step_type', 'landing'),
            'step_type', e.elem->>'step_type',
            'page_id', e.elem->>'page_id',
            'step_index', e.elem->'step_index',
            'url_to_swipe', e.elem->>'url_to_swipe',
            'prompt', e.elem->>'prompt',
            'cloned_data', jsonb_build_object(
              'source_url', COALESCE(e.elem#>>'{cloned_data,source_url}', e.elem->>'url_to_swipe'),
              'screenshotDesktopUrl', e.elem#>>'{cloned_data,screenshotDesktopUrl}',
              'screenshotMobileUrl', e.elem#>>'{cloned_data,screenshotMobileUrl}',
              'htmlUrl', e.elem#>>'{cloned_data,htmlUrl}',
              'category', COALESCE(e.elem#>>'{cloned_data,category}', f.name),
              'tags', COALESCE(e.elem#>'{cloned_data,tags}', '[]'::jsonb)
            )
          ) AS step
        FROM jsonb_array_elements(COALESCE(f.steps::jsonb, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
      ) s
    ), '[]'::jsonb) AS steps
  FROM archived_funnels f
  WHERE (p_project_id IS NULL AND f.project_id IS NULL)
     OR (p_project_id IS NOT NULL AND f.project_id = p_project_id)
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 400), 2000));
$$;
GRANT EXECUTE ON FUNCTION public.slim_archived_funnels(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_archived_funnels(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_archived_funnels(uuid, int) TO anon;
`;

function asSteps(raw: unknown): SlimArchiveStep[] {
  if (Array.isArray(raw)) return raw as SlimArchiveStep[];
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? (p as SlimArchiveStep[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function slimOneStep(raw: Record<string, unknown>): Record<string, unknown> {
  const step = { ...raw };
  const pid = typeof step.page_id === 'string' ? step.page_id : '';
  for (const key of ['cloned_data', 'swiped_data', 'extracted_data'] as const) {
    const blob = step[key];
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) continue;
    const b = { ...(blob as Record<string, unknown>) };
    delete b.html;
    delete b.mobileHtml;
    delete b.htmlMobile;
    delete b.rawHtml;
    delete b.renderedHtml;
    delete b.content;
    if (pid && typeof b.htmlUrl !== 'string') {
      b.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(pid)}&kind=cloned&variant=desktop`;
    }
    step[key] = b;
  }
  return step;
}

/** `archived_funnels.total_steps` is TEXT in the DB, so Supabase returns
 *  strings like "8". Treating those as "not a number" zeroed the count,
 *  made every funnel look like a single page and dropped it from the
 *  Templates/Chimera lists entirely. Coerce robustly instead. */
function asTotalSteps(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asRows(data: unknown): SlimArchiveRow[] {
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((row) => {
      const r = row as Record<string, unknown>;
      const steps = asSteps(r.steps).map((s) => slimOneStep(s as Record<string, unknown>) as SlimArchiveStep);
      return {
        id: String(r.id || ''),
        name: String(r.name || ''),
        created_at: String(r.created_at || ''),
        total_steps: asTotalSteps(r.total_steps, steps.length),
        project_id: r.project_id ? String(r.project_id) : null,
        section: typeof r.section === 'string' ? r.section : null,
        steps,
      };
    })
    .filter((r) => r.id);
}

const META_COLS = 'id, name, created_at, total_steps, project_id, section';
const LIST_COLS = `${META_COLS}, list_page_type, list_source_url, list_shot, list_shot_mobile, list_html_url, list_tags, list_geo, list_category`;

const CREATE_LIST_COLS_SQL = `
ALTER TABLE public.archived_funnels
  ADD COLUMN IF NOT EXISTS list_page_type text,
  ADD COLUMN IF NOT EXISTS list_source_url text,
  ADD COLUMN IF NOT EXISTS list_shot text,
  ADD COLUMN IF NOT EXISTS list_shot_mobile text,
  ADD COLUMN IF NOT EXISTS list_html_url text,
  ADD COLUMN IF NOT EXISTS list_tags jsonb,
  ADD COLUMN IF NOT EXISTS list_geo text,
  ADD COLUMN IF NOT EXISTS list_category text;

CREATE OR REPLACE FUNCTION public.template_list_cards(p_limit int DEFAULT 500)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  total_steps int,
  project_id uuid,
  section text,
  list_page_type text,
  list_source_url text,
  list_shot text,
  list_shot_mobile text,
  list_html_url text,
  list_tags jsonb,
  list_geo text,
  list_category text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
SET statement_timeout TO '20s'
AS $$
  SELECT
    f.id,
    f.name,
    f.created_at,
    COALESCE(
      CASE
        WHEN btrim(COALESCE(f.total_steps::text, '')) ~ '^[0-9]+$'
        THEN btrim(f.total_steps::text)::integer
        ELSE NULL
      END,
      1
    ) AS total_steps,
    f.project_id,
    f.section::text,
    f.list_page_type,
    f.list_source_url,
    f.list_shot,
    f.list_shot_mobile,
    f.list_html_url,
    f.list_tags,
    f.list_geo,
    f.list_category
  FROM archived_funnels f
  WHERE f.project_id IS NULL
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
$$;
GRANT EXECUTE ON FUNCTION public.template_list_cards(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.template_list_cards(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.template_list_cards(int) TO anon;
NOTIFY pgrst, 'reload schema';
`;

const BACKFILL_LIST_SQL = `
UPDATE public.archived_funnels f
SET
  list_page_type = COALESCE(f.steps->0->>'page_type', f.steps->0->>'step_type', 'landing'),
  list_source_url = COALESCE(f.steps->0#>>'{cloned_data,source_url}', f.steps->0->>'url_to_swipe'),
  list_shot = NULLIF(f.steps->0#>>'{cloned_data,screenshotDesktopUrl}', ''),
  list_shot_mobile = NULLIF(f.steps->0#>>'{cloned_data,screenshotMobileUrl}', ''),
  list_html_url = NULLIF(f.steps->0#>>'{cloned_data,htmlUrl}', ''),
  list_tags = COALESCE(f.steps->0#>'{cloned_data,tags}', '[]'::jsonb),
  list_geo = NULLIF(f.steps->0#>>'{cloned_data,geo}', ''),
  list_category = COALESCE(NULLIF(f.steps->0#>>'{cloned_data,category}', ''), NULLIF(f.steps->0->>'category', ''), f.name)
WHERE f.id IN (
  SELECT id FROM public.archived_funnels
  WHERE project_id IS NULL
    AND (list_page_type IS NULL OR btrim(list_page_type) = '')
  ORDER BY created_at DESC
  LIMIT 80
);
`;
/** Netlify's edge wrapper kills this HTTP request around 10–26s even when
 *  the function maxDuration is higher. Never touch `steps` jsonb here — those
 *  rows still hold 1–5 MB of HTML and that is what timed Templates out. */
const TEMPLATE_BUDGET_MS = 20_000;
const TEMPLATE_RPC_MAX = 500;
const PATH_BATCH = 12;

/**
 * Scalars only — never `steps` or `cloned_data` objects (those still contain
 * 1–5 MB HTML and are what timed out Template → Pages).
 */
const PATH_SELECT = [
  META_COLS,
  'step_name:steps->0->>name',
  'page_type:steps->0->>page_type',
  'step_type:steps->0->>step_type',
  'page_id:steps->0->>page_id',
  'url_to_swipe:steps->0->>url_to_swipe',
  'prompt:steps->0->>prompt',
  'source_url:steps->0->cloned_data->>source_url',
  'screenshot_desktop:steps->0->cloned_data->>screenshotDesktopUrl',
  'screenshot_mobile:steps->0->cloned_data->>screenshotMobileUrl',
  'html_url:steps->0->cloned_data->>htmlUrl',
  'category:steps->0->cloned_data->>category',
].join(', ');

const CREATE_TEMPLATE_PAGES_FN = `
CREATE OR REPLACE FUNCTION public.slim_template_pages(p_limit int DEFAULT 40, p_offset int DEFAULT 0)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  total_steps int,
  project_id uuid,
  section text,
  steps jsonb
)
LANGUAGE sql
STABLE
SET statement_timeout TO '8s'
AS $$
  SELECT
    f.id,
    f.name,
    f.created_at,
    COALESCE(
      CASE
        WHEN btrim(COALESCE(f.total_steps::text, '')) ~ '^[0-9]+$'
        THEN btrim(f.total_steps::text)::integer
        ELSE NULL
      END,
      0
    ) AS total_steps,
    f.project_id,
    f.section::text,
    jsonb_build_array(
      jsonb_build_object(
        'name', COALESCE(f.steps->0->>'name', f.name),
        'page_type', COALESCE(f.steps->0->>'page_type', f.steps->0->>'step_type', 'landing'),
        'step_type', f.steps->0->>'step_type',
        'page_id', f.steps->0->>'page_id',
        'step_index', COALESCE(f.steps->0->'step_index', '1'::jsonb),
        'url_to_swipe', f.steps->0->>'url_to_swipe',
        'prompt', f.steps->0->>'prompt',
        'cloned_data', jsonb_build_object(
          'source_url', COALESCE(f.steps->0#>>'{cloned_data,source_url}', f.steps->0->>'url_to_swipe'),
          'screenshotDesktopUrl', f.steps->0#>>'{cloned_data,screenshotDesktopUrl}',
          'screenshotMobileUrl', f.steps->0#>>'{cloned_data,screenshotMobileUrl}',
          'htmlUrl', f.steps->0#>>'{cloned_data,htmlUrl}',
          'category', COALESCE(f.steps->0#>>'{cloned_data,category}', f.name),
          'tags', COALESCE(f.steps->0#>'{cloned_data,tags}', '[]'::jsonb)
        )
      )
    ) AS steps
  FROM archived_funnels f
  WHERE f.project_id IS NULL
    AND (
      COALESCE(f.section::text, '') = 'page'
      OR COALESCE(
        CASE
          WHEN btrim(COALESCE(f.total_steps::text, '')) ~ '^[0-9]+$'
          THEN btrim(f.total_steps::text)::integer
          ELSE NULL
        END,
        1
      ) <= 1
    )
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;
GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO anon;
`;

/** Mirror of slim_template_pages for the FUNNEL rows (multi-step, not
 *  section='page'). Returns slim steps (no HTML) so Templates → Funnel and
 *  the Chimera funnel picker get real step lists without heavy payloads. */
const CREATE_TEMPLATE_FUNNELS_FN = `
CREATE OR REPLACE FUNCTION public.slim_template_funnels(p_limit int DEFAULT 40, p_offset int DEFAULT 0)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  total_steps int,
  project_id uuid,
  section text,
  steps jsonb
)
LANGUAGE sql
STABLE
SET statement_timeout TO '8s'
AS $$
  SELECT
    f.id,
    f.name,
    f.created_at,
    COALESCE(
      CASE
        WHEN btrim(COALESCE(f.total_steps::text, '')) ~ '^[0-9]+$'
        THEN btrim(f.total_steps::text)::integer
        ELSE NULL
      END,
      0
    ) AS total_steps,
    f.project_id,
    f.section::text,
    COALESCE((
      SELECT jsonb_agg(s.step ORDER BY s.ord)
      FROM (
        SELECT
          e.ord,
          jsonb_build_object(
            'name', e.elem->>'name',
            'page_type', COALESCE(e.elem->>'page_type', e.elem->>'step_type', 'landing'),
            'step_type', e.elem->>'step_type',
            'page_id', e.elem->>'page_id',
            'step_index', e.elem->'step_index',
            'url_to_swipe', e.elem->>'url_to_swipe',
            'prompt', e.elem->>'prompt',
            'cloned_data', jsonb_build_object(
              'source_url', COALESCE(e.elem#>>'{cloned_data,source_url}', e.elem->>'url_to_swipe'),
              'screenshotDesktopUrl', e.elem#>>'{cloned_data,screenshotDesktopUrl}',
              'screenshotMobileUrl', e.elem#>>'{cloned_data,screenshotMobileUrl}',
              'htmlUrl', e.elem#>>'{cloned_data,htmlUrl}',
              'category', COALESCE(e.elem#>>'{cloned_data,category}', f.name),
              'tags', COALESCE(e.elem#>'{cloned_data,tags}', '[]'::jsonb)
            )
          ) AS step
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(COALESCE(f.steps::jsonb, '[]'::jsonb)) = 'array' THEN COALESCE(f.steps::jsonb, '[]'::jsonb)
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS e(elem, ord)
      ) s
    ), '[]'::jsonb) AS steps
  FROM archived_funnels f
  WHERE f.project_id IS NULL
    AND COALESCE(f.section::text, '') <> 'page'
    AND GREATEST(
      COALESCE(
        CASE
          WHEN btrim(COALESCE(f.total_steps::text, '')) ~ '^[0-9]+$'
          THEN btrim(f.total_steps::text)::integer
          ELSE NULL
        END,
        0
      ),
      CASE
        WHEN jsonb_typeof(COALESCE(f.steps::jsonb, '[]'::jsonb)) = 'array'
        THEN jsonb_array_length(COALESCE(f.steps::jsonb, '[]'::jsonb))
        ELSE 0
      END
    ) >= 2
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;
GRANT EXECUTE ON FUNCTION public.slim_template_funnels(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_template_funnels(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_template_funnels(int, int) TO anon;
`;

function isPageRow(r: { section?: string | null; total_steps?: number | null; steps?: unknown[] }): boolean {
  if (r.section === 'page') return true;
  const n = Array.isArray(r.steps) && r.steps.length
    ? r.steps.length
    : asTotalSteps(r.total_steps, 1);
  return n <= 1;
}

function pickField(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function pathRowToStep(row: Record<string, unknown>): SlimArchiveStep {
  const pageId = pickField(row, ['page_id', 'steps->0->>page_id']);
  const htmlUrl =
    pickField(row, ['html_url', 'htmlUrl', 'steps->0->cloned_data->>htmlUrl']) ||
    (pageId ? `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop` : undefined);
  return {
    name: pickField(row, ['step_name', 'steps->0->>name']) || String(row.name || ''),
    page_type: pickField(row, ['page_type', 'steps->0->>page_type', 'step_type']) || 'landing',
    step_type: pickField(row, ['step_type', 'steps->0->>step_type']) || undefined,
    page_id: pageId || undefined,
    url_to_swipe: pickField(row, ['url_to_swipe', 'steps->0->>url_to_swipe']),
    prompt: pickField(row, ['prompt', 'steps->0->>prompt']) || undefined,
    cloned_data: {
      source_url: pickField(row, ['source_url', 'url_to_swipe']) || undefined,
      screenshotDesktopUrl: pickField(row, ['screenshot_desktop', 'steps->0->cloned_data->>screenshotDesktopUrl']) || null,
      screenshotMobileUrl: pickField(row, ['screenshot_mobile', 'steps->0->cloned_data->>screenshotMobileUrl']) || null,
      htmlUrl,
      category: pickField(row, ['category', 'steps->0->cloned_data->>category']) || String(row.name || '') || undefined,
      tags: [],
    },
  };
}

async function loadMeta(projectId: string | null, limit: number): Promise<SlimArchiveRow[]> {
  let q = supabaseAdmin
    .from('archived_funnels')
    .select(META_COLS)
    .order('created_at', { ascending: false })
    .limit(limit);
  q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
  const meta = await q;
  if (meta.error) throw new Error(meta.error.message);
  return asRows((meta.data || []).map((r) => ({ ...r, steps: [] })));
}

async function hydrateViaJsonPaths(
  ids: string[],
  deadline: number,
): Promise<Map<string, SlimArchiveStep[]>> {
  const out = new Map<string, SlimArchiveStep[]>();
  if (ids.length === 0) return out;
  let select = PATH_SELECT;
  let aliasFailed = false;

  for (let i = 0; i < ids.length && Date.now() < deadline; i += PATH_BATCH) {
    const slice = ids.slice(i, i + PATH_BATCH);
    const ms = Math.max(800, Math.min(6_000, deadline - Date.now()));
    try {
      const { data, error } = await supabaseAdmin
        .from('archived_funnels')
        .select(select)
        .in('id', slice)
        .abortSignal(AbortSignal.timeout(ms));
      if (error || !Array.isArray(data)) {
        const msg = error?.message || '';
        console.warn('[slim-archived-funnels] path select:', msg);
        if (!aliasFailed && /parse|syntax|could not|invalid/i.test(msg)) {
          aliasFailed = true;
          select = `${META_COLS}, steps->0->>page_type, steps->0->>name, steps->0->>url_to_swipe, steps->0->cloned_data->>screenshotDesktopUrl, steps->0->cloned_data->>htmlUrl`;
          i -= PATH_BATCH;
        }
        continue;
      }
      for (const raw of data) {
        const row = raw as Record<string, unknown>;
        const id = String(row.id || '');
        if (!id) continue;
        out.set(id, [pathRowToStep(row)]);
      }
    } catch (e) {
      console.warn(
        '[slim-archived-funnels] path select aborted:',
        e instanceof Error ? e.message : e,
      );
    }
  }
  return out;
}

async function loadTemplateRpc(
  fn: string,
  deadline: number,
  cap = 2000,
): Promise<SlimArchiveRow[] | null> {
  const rows: SlimArchiveRow[] = [];
  const pageSize = 80;
  for (let offset = 0; offset < cap && Date.now() < deadline; offset += pageSize) {
    const take = Math.min(pageSize, cap - offset, TEMPLATE_RPC_MAX);
    const ms = Math.max(800, Math.min(8_000, deadline - Date.now()));
    try {
      const { data, error } = await supabaseAdmin.rpc(
        fn,
        { p_limit: take, p_offset: offset },
        { abortSignal: AbortSignal.timeout(ms) },
      );
      if (error) {
        if (/does not exist|42883/i.test(error.message || '')) return null;
        console.warn(`[slim-archived-funnels] ${fn}:`, error.message);
        break;
      }
      const batch = asRows(data);
      if (!batch.length) break;
      rows.push(...batch);
      if (batch.length < take) break;
    } catch (e) {
      console.warn(
        `[slim-archived-funnels] ${fn} aborted:`,
        e instanceof Error ? e.message : e,
      );
      break;
    }
  }
  return rows;
}

const loadTemplatePagesRpc = (deadline: number, cap: number) =>
  loadTemplateRpc('slim_template_pages', deadline, cap);
const loadTemplateFunnelsRpc = (deadline: number, cap: number) =>
  loadTemplateRpc('slim_template_funnels', deadline, cap);

/** Fallback when the slim_template_funnels RPC is missing (e.g. exec_sql not
 *  available on this Supabase): rebuild each funnel's step list from SCALAR
 *  json-path selects only. Never pull the raw `steps` jsonb — walk saves can
 *  carry 1–5 MB of HTML per step and the fetch times out (that's exactly how
 *  tryrosabella/nooro stayed empty while 2-step funnels hydrated fine). */
const MAX_FUNNEL_STEPS = 24;

function funnelShellSelect(count: number): string {
  const cols: string[] = ['id', 'name'];
  for (let i = 0; i < count; i++) {
    cols.push(
      `s${i}_name:steps->${i}->>name`,
      `s${i}_ptype:steps->${i}->>page_type`,
      `s${i}_stype:steps->${i}->>step_type`,
      `s${i}_pid:steps->${i}->>page_id`,
      `s${i}_url:steps->${i}->>url_to_swipe`,
    );
  }
  return cols.join(', ');
}

function stepFromPathRow(row: Record<string, unknown>, i: number, rowName: string): SlimArchiveStep | null {
  const g = (k: string) => {
    const v = row[`s${i}_${k}`];
    return v == null ? '' : String(v).trim();
  };
  const name = g('name');
  const ptype = g('ptype') || g('stype');
  const url = g('url') || g('src');
  if (!name && !ptype && !url) return null; // past the end of the array
  const pageId = g('pid');
  const htmlUrl =
    g('html') ||
    (pageId ? `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=cloned&variant=desktop` : undefined);
  return {
    name: name || `Step ${i + 1}`,
    page_type: ptype || 'landing',
    step_type: g('stype') || undefined,
    page_id: pageId || undefined,
    step_index: i + 1,
    url_to_swipe: url,
    prompt: g('prompt') || undefined,
    cloned_data: {
      source_url: g('src') || url || undefined,
      screenshotDesktopUrl: g('shot') || null,
      screenshotMobileUrl: g('shotm') || null,
      htmlUrl,
      category: g('cat') || rowName || undefined,
      tags: [],
    },
  };
}

async function hydrateFunnelSteps(rows: SlimArchiveRow[], deadline: number): Promise<void> {
  const todo = rows.filter((r) => !r.steps.length);
  for (const row of todo) {
    if (Date.now() >= deadline) break;
    const count = Math.max(2, Math.min(MAX_FUNNEL_STEPS, asTotalSteps(row.total_steps, 2)));
    const ms = Math.max(800, Math.min(6_000, deadline - Date.now()));
    try {
      const { data, error } = await supabaseAdmin
        .from('archived_funnels')
        .select(funnelShellSelect(count))
        .eq('id', row.id)
        .abortSignal(AbortSignal.timeout(ms))
        .maybeSingle();
      if (error || !data) {
        console.warn('[slim-archived-funnels] funnel steps hydrate:', error?.message);
        continue;
      }
      const steps: SlimArchiveStep[] = [];
      for (let i = 0; i < count; i++) {
        const s = stepFromPathRow(data as unknown as Record<string, unknown>, i, row.name);
        if (!s) break;
        steps.push(s);
      }
      if (steps.length) {
        row.steps = steps;
        if (!row.total_steps) row.total_steps = steps.length;
      }
    } catch (e) {
      console.warn(
        '[slim-archived-funnels] funnel steps hydrate aborted:',
        e instanceof Error ? e.message : e,
      );
    }
  }
}

const CREATE_STEP_SHELLS_FN = `
CREATE OR REPLACE FUNCTION public.slim_funnel_step_shells(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET statement_timeout TO '12s'
AS $$
  SELECT COALESCE((
    SELECT jsonb_agg(s.step ORDER BY s.ord)
    FROM (
      SELECT
        e.ord,
        jsonb_build_object(
          'name', e.elem->>'name',
          'page_type', COALESCE(e.elem->>'page_type', e.elem->>'step_type', 'landing'),
          'step_type', e.elem->>'step_type',
          'page_id', e.elem->>'page_id',
          'step_index', e.elem->'step_index',
          'url_to_swipe', COALESCE(e.elem->>'url_to_swipe', e.elem#>>'{cloned_data,source_url}')
        ) AS step
      FROM archived_funnels f
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(COALESCE(f.steps::jsonb, '[]'::jsonb)) = 'array'
            THEN COALESCE(f.steps::jsonb, '[]'::jsonb)
          WHEN jsonb_typeof(COALESCE(f.steps::jsonb, '[]'::jsonb)) = 'string'
            THEN COALESCE((f.steps#>>'{}')::jsonb, '[]'::jsonb)
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS e(elem, ord)
      WHERE f.id = p_id
    ) s
  ), '[]'::jsonb);
$$;
GRANT EXECUTE ON FUNCTION public.slim_funnel_step_shells(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_funnel_step_shells(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_funnel_step_shells(uuid) TO anon;
`;

function stepsFromShellRow(data: Record<string, unknown>, name: string, count: number): SlimArchiveStep[] {
  const steps: SlimArchiveStep[] = [];
  for (let i = 0; i < count; i++) {
    const s = stepFromPathRow(data, i, name);
    if (!s) break;
    steps.push(s);
  }
  return steps;
}

/** Lightweight step list for the Chimera picker (name / type / url only). */
export async function loadFunnelStepShells(id: string): Promise<SlimArchiveStep[]> {
  if (!id) return [];
  await ensureSlimFn();
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'slim_funnel_step_shells',
      { p_id: id },
      { abortSignal: AbortSignal.timeout(12_000) },
    );
    if (!error && data != null) {
      const steps = asSteps(data).map((s) => slimOneStep(s as Record<string, unknown>) as SlimArchiveStep);
      if (steps.length) return steps;
    } else if (error && /does not exist|42883/i.test(error.message || '')) {
      ensurePromise = null;
      await ensureSlimFn();
      const retry = await supabaseAdmin.rpc(
        'slim_funnel_step_shells',
        { p_id: id },
        { abortSignal: AbortSignal.timeout(12_000) },
      );
      if (!retry.error && retry.data != null) {
        const steps = asSteps(retry.data).map((s) => slimOneStep(s as Record<string, unknown>) as SlimArchiveStep);
        if (steps.length) return steps;
      }
    } else if (error) {
      console.warn('[slim-archived-funnels] step shells rpc:', error.message);
    }
  } catch (e) {
    console.warn('[slim-archived-funnels] step shells rpc aborted:', e instanceof Error ? e.message : e);
  }

  const meta = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, total_steps')
    .eq('id', id)
    .maybeSingle();
  if (meta.error || !meta.data) return [];
  const name = String(meta.data.name || '');
  const count = Math.max(2, Math.min(MAX_FUNNEL_STEPS, asTotalSteps(meta.data.total_steps, 24)));
  try {
    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .select(funnelShellSelect(count))
      .eq('id', id)
      .abortSignal(AbortSignal.timeout(12_000))
      .maybeSingle();
    if (error || !data) {
      console.warn('[slim-archived-funnels] step shells path:', error?.message);
      return [];
    }
    return stepsFromShellRow(data as Record<string, unknown>, name, count);
  } catch (e) {
    console.warn('[slim-archived-funnels] step shells path aborted:', e instanceof Error ? e.message : e);
    return [];
  }
}

let ensurePromise: Promise<void> | null = null;

async function ensureSlimFn(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const jobs: Array<[string, string]> = [
        ['slim RPC', CREATE_SLIM_FN],
        ['template RPC', CREATE_TEMPLATE_PAGES_FN],
        ['funnel RPC', CREATE_TEMPLATE_FUNNELS_FN],
        ['step-shell RPC', CREATE_STEP_SHELLS_FN],
      ];
      await Promise.all(
        jobs.map(async ([label, sql]) => {
          const res = await supabaseAdmin.rpc(
            'exec_sql',
            { sql },
            { abortSignal: AbortSignal.timeout(4_000) },
          );
          if (res.error) console.warn(`[slim-archived-funnels] could not create ${label}:`, res.error.message);
        }),
      );
    })().catch((e) => {
      console.warn('[slim-archived-funnels] ensure failed:', e);
    });
  }
  await ensurePromise;
}

async function loadViaProjectRpc(
  projectId: string,
  cap: number,
): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  const args = { p_project_id: projectId, p_limit: cap };
  let { data, error } = await supabaseAdmin.rpc('slim_archived_funnels', args, {
    abortSignal: AbortSignal.timeout(10_000),
  });
  if (error && /does not exist|42883/i.test(error.message || '')) {
    await ensureSlimFn();
    const retry = await supabaseAdmin.rpc('slim_archived_funnels', args, {
      abortSignal: AbortSignal.timeout(10_000),
    });
    data = retry.data;
    error = retry.error;
  }
  if (!error) return { rows: asRows(data), error: null };
  console.warn('[slim-archived-funnels] project RPC failed, json-path hydrate:', error.message);
  try {
    const rows = await loadMeta(projectId, cap);
    const stepsById = await hydrateViaJsonPaths(
      rows.map((r) => r.id),
      Date.now() + 10_000,
    );
    for (const r of rows) {
      const steps = stepsById.get(r.id);
      if (steps?.length) {
        r.steps = steps;
        if (!r.total_steps) r.total_steps = steps.length;
      }
    }
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function createdAtMs(row: SlimArchiveRow): number {
  const t = Date.parse(row.created_at);
  return Number.isFinite(t) ? t : 0;
}

let listColsPromise: Promise<void> | null = null;

async function ensureListCols(): Promise<void> {
  if (!listColsPromise) {
    listColsPromise = (async () => {
      const res = await supabaseAdmin.rpc(
        'exec_sql',
        { sql: CREATE_LIST_COLS_SQL },
        { abortSignal: AbortSignal.timeout(8_000) },
      );
      if (res.error) console.warn('[slim-archived-funnels] list cols:', res.error.message);
    })().catch((e) => {
      console.warn('[slim-archived-funnels] list cols failed:', e);
    });
  }
  await listColsPromise;
}

async function backfillListCols(): Promise<void> {
  try {
    const res = await supabaseAdmin.rpc(
      'exec_sql',
      { sql: BACKFILL_LIST_SQL },
      { abortSignal: AbortSignal.timeout(6_000) },
    );
    if (res.error) console.warn('[slim-archived-funnels] list backfill:', res.error.message);
  } catch (e) {
    console.warn('[slim-archived-funnels] list backfill aborted:', e instanceof Error ? e.message : e);
  }
}

function listTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.map((t) => String(t).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function listRowToSlim(raw: Record<string, unknown>): SlimArchiveRow {
  const id = String(raw.id || '');
  const name = String(raw.name || '');
  const total = asTotalSteps(raw.total_steps, 1);
  const section = typeof raw.section === 'string' ? raw.section : null;
  const isPage = section === 'page' || total <= 1;
  const url = String(raw.list_source_url || '').trim();
  const pageType = String(raw.list_page_type || '').trim() || 'landing';
  const htmlUrl =
    String(raw.list_html_url || '').trim() ||
    (id ? `/api/funnel-html?pageId=${encodeURIComponent(id)}&kind=cloned&variant=desktop` : undefined);
  const steps: SlimArchiveStep[] = isPage
    ? [
        {
          name,
          page_type: pageType,
          page_id: id,
          step_index: 1,
          url_to_swipe: url,
          cloned_data: {
            source_url: url || undefined,
            screenshotDesktopUrl: (typeof raw.list_shot === 'string' && raw.list_shot) || null,
            screenshotMobileUrl: (typeof raw.list_shot_mobile === 'string' && raw.list_shot_mobile) || null,
            htmlUrl,
            category: String(raw.list_category || name || '') || undefined,
            tags: listTags(raw.list_tags),
            geo: String(raw.list_geo || '').trim() || undefined,
          },
        },
      ]
    : [];
  return {
    id,
    name,
    created_at: String(raw.created_at || ''),
    total_steps: total,
    project_id: raw.project_id ? String(raw.project_id) : null,
    section,
    steps,
  };
}

async function loadListCards(cap: number): Promise<{ rows: SlimArchiveRow[]; untyped: number } | null> {
  const mapRows = (data: unknown) => {
    let untyped = 0;
    const rows = (Array.isArray(data) ? data : []).map((raw) => {
      const r = raw as Record<string, unknown>;
      if (!String(r.list_page_type || '').trim()) untyped += 1;
      return listRowToSlim(r);
    }).filter((r) => r.id);
    return { rows, untyped };
  };
  try {
    const rpc = await supabaseAdmin.rpc(
      'template_list_cards',
      { p_limit: cap },
      { abortSignal: AbortSignal.timeout(15_000) },
    );
    if (!rpc.error && rpc.data) return mapRows(rpc.data);
  } catch (e) {
    console.warn('[slim-archived-funnels] list rpc:', e instanceof Error ? e.message : e);
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .select(LIST_COLS)
      .is('project_id', null)
      .order('created_at', { ascending: false })
      .limit(cap)
      .abortSignal(AbortSignal.timeout(15_000));
    if (error) {
      console.warn('[slim-archived-funnels] list cards:', error.message);
      return null;
    }
    return mapRows(data);
  } catch (e) {
    console.warn('[slim-archived-funnels] list cards aborted:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function selectArchiveLight(
  cols: string,
  cap: number,
  ms: number,
): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select(cols)
    .is('project_id', null)
    .order('created_at', { ascending: false })
    .limit(cap)
    .abortSignal(AbortSignal.timeout(ms));
  if (error) return { rows: [], error: error.message };
  const rows = (Array.isArray(data) ? data : [])
    .map((raw) => listRowToSlim(raw as Record<string, unknown>))
    .filter((r) => r.id);
  return { rows, error: null };
}

async function loadTemplateArchives(cap: number): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  // One admin SELECT. Do not wait on exec_sql / RPC create — that is what
  // returned an empty Template list when the DB was slow.
  try {
    const listed = await selectArchiveLight(LIST_COLS, cap, 8_000);
    if (listed.rows.length || !listed.error) return listed;
  } catch (e) {
    console.warn('[slim-archived-funnels] list cols select:', e instanceof Error ? e.message : e);
  }
  try {
    return await selectArchiveLight(META_COLS, cap, 8_000);
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Funnels for one project, or templates when projectId is null. */
export async function loadSlimArchivedFunnels(
  projectId: string | null,
  limit = 400,
): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  const cap = Math.max(1, Math.min(limit, 2000));
  if (projectId) return loadViaProjectRpc(projectId, cap);
  return loadTemplateArchives(cap);
}
