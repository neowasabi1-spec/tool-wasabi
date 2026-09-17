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
        total_steps: typeof r.total_steps === 'number' ? r.total_steps : steps.length,
        project_id: r.project_id ? String(r.project_id) : null,
        section: typeof r.section === 'string' ? r.section : null,
        steps,
      };
    })
    .filter((r) => r.id);
}

const META_COLS = 'id, name, created_at, total_steps, project_id, section';
const PAGE = 20;
const WAVE = 3;

async function loadStepsForIds(ids: string[]): Promise<Map<string, SlimArchiveStep[]>> {
  const out = new Map<string, SlimArchiveStep[]>();
  if (ids.length === 0) return out;

  const { data, error } = await supabaseAdmin.from('archived_funnels').select('id, steps').in('id', ids);

  if (!error && Array.isArray(data)) {
    for (const row of data) {
      out.set(
        String((row as { id: string }).id),
        asSteps((row as { steps?: unknown }).steps).map(
          (s) => slimOneStep(s as Record<string, unknown>) as SlimArchiveStep,
        ),
      );
    }
    return out;
  }

  console.warn('[slim-archived-funnels] batch steps failed, per-row:', error?.message);
  for (const id of ids) {
    const one = await supabaseAdmin.from('archived_funnels').select('id, steps').eq('id', id).maybeSingle();
    if (one.error || !one.data) {
      out.set(id, []);
      continue;
    }
    out.set(
      id,
      asSteps((one.data as { steps?: unknown }).steps).map(
        (s) => slimOneStep(s as Record<string, unknown>) as SlimArchiveStep,
      ),
    );
  }
  return out;
}

async function loadPaged(projectId: string | null, limit: number): Promise<SlimArchiveRow[]> {
  let q = supabaseAdmin.from('archived_funnels').select(META_COLS).order('created_at', { ascending: false }).limit(limit);
  q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
  const meta = await q;
  if (meta.error) throw new Error(meta.error.message);
  const rows = asRows((meta.data || []).map((r) => ({ ...r, steps: [] })));
  const batches: SlimArchiveRow[][] = [];
  for (let i = 0; i < rows.length; i += PAGE) batches.push(rows.slice(i, i + PAGE));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(WAVE, Math.max(batches.length, 1)) }, async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= batches.length) return;
        const slice = batches[idx];
        const stepsById = await loadStepsForIds(slice.map((r) => r.id));
        for (const r of slice) {
          const steps = stepsById.get(r.id) || [];
          r.steps = steps;
          if (!r.total_steps) r.total_steps = steps.length;
        }
      }
    }),
  );
  return rows;
}

async function ensureSlimFn(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql: CREATE_SLIM_FN });
  if (error) console.warn('[slim-archived-funnels] could not create RPC:', error.message);
}

/** Funnels for one project, or templates when projectId is null. */
export async function loadSlimArchivedFunnels(
  projectId: string | null,
  limit = 400,
): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  const cap = Math.max(1, Math.min(limit, 2000));

  if (projectId) {
    const args = { p_project_id: projectId, p_limit: cap };
    let { data, error } = await supabaseAdmin.rpc('slim_archived_funnels', args);
    if (error && /does not exist|42883/i.test(error.message || '')) {
      await ensureSlimFn();
      const retry = await supabaseAdmin.rpc('slim_archived_funnels', args);
      data = retry.data;
      error = retry.error;
    }
    if (!error) return { rows: asRows(data), error: null };
    console.warn('[slim-archived-funnels] RPC failed, paging steps:', error.message);
  }

  try {
    return { rows: await loadPaged(projectId, cap), error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}
