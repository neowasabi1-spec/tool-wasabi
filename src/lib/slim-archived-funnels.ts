/**
 * Read archived_funnels without pulling cloned_data.html (often 1–5 MB per
 * step). Selecting the raw `steps` JSONB times out Postgres and can stall the
 * whole Supabase project — Competitor Landings then looks empty.
 */

import { supabaseAdmin } from './supabase-admin';

export type SlimArchiveStep = {
  name?: string;
  page_type?: string;
  step_type?: string;
  page_id?: string;
  step_index?: number;
  url_to_swipe?: string;
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

function asRows(data: unknown): SlimArchiveRow[] {
  const arr = Array.isArray(data) ? data : [];
  return arr.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id || ''),
      name: String(r.name || ''),
      created_at: String(r.created_at || ''),
      total_steps: typeof r.total_steps === 'number' ? r.total_steps : null,
      project_id: r.project_id ? String(r.project_id) : null,
      section: typeof r.section === 'string' ? r.section : null,
      steps: asSteps(r.steps),
    };
  }).filter((r) => r.id);
}

async function ensureSlimFn(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql: CREATE_SLIM_FN });
  if (error) console.warn('[slim-archived-funnels] could not create RPC:', error.message);
}

/** Funnels for one project, or templates when projectId is null. HTML stays in page_html. */
export async function loadSlimArchivedFunnels(
  projectId: string | null,
  limit = 400,
): Promise<{ rows: SlimArchiveRow[]; error: string | null }> {
  const args = { p_project_id: projectId, p_limit: limit };
  let { data, error } = await supabaseAdmin.rpc('slim_archived_funnels', args);
  if (error && /does not exist|42883/i.test(error.message || '')) {
    await ensureSlimFn();
    const retry = await supabaseAdmin.rpc('slim_archived_funnels', args);
    data = retry.data;
    error = retry.error;
  }
  if (!error) return { rows: asRows(data), error: null };

  console.warn('[slim-archived-funnels] RPC failed, metadata fallback:', error.message);
  let q = supabaseAdmin
    .from('archived_funnels')
    .select('id, name, created_at, total_steps, project_id, section')
    .order('created_at', { ascending: false })
    .limit(limit);
  q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
  const fallback = await q;
  if (fallback.error) return { rows: [], error: fallback.error.message };
  return {
    rows: ((fallback.data || []) as SlimArchiveRow[]).map((r) => ({ ...r, steps: [] })),
    error: null,
  };
}
