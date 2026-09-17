/**
 * List funnel_pages without pulling cloned_data.html (often 1–5 MB per row).
 * `SELECT *` on that table is what makes Clone/Swipe and app boot feel frozen
 * and is the Postgres `57014 statement timeout` in the dashboard logs.
 */

import { supabaseAdmin } from './supabase-admin';

const HTML_KEYS = ['html', 'mobileHtml', 'htmlMobile', 'rawHtml', 'renderedHtml', 'content'] as const;

const CREATE_SLIM_FN = `
CREATE OR REPLACE FUNCTION public.slim_funnel_pages(p_limit int DEFAULT 2000)
RETURNS TABLE (
  id uuid,
  name text,
  page_type text,
  template_id uuid,
  product_id uuid,
  project_id uuid,
  url_to_swipe text,
  angle text,
  prompt text,
  swipe_status text,
  swipe_result text,
  feedback text,
  analysis_status text,
  analysis_result text,
  cloned_data jsonb,
  swiped_data jsonb,
  extracted_data jsonb,
  owner_user_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SET statement_timeout TO '30s'
AS $$
  SELECT
    f.id,
    f.name,
    f.page_type::text,
    f.template_id,
    f.product_id,
    f.project_id,
    f.url_to_swipe,
    f.angle,
    f.prompt,
    f.swipe_status::text,
    f.swipe_result,
    f.feedback,
    f.analysis_status::text,
    f.analysis_result,
    CASE WHEN f.cloned_data IS NULL THEN NULL ELSE
      (f.cloned_data - 'html' - 'mobileHtml' - 'htmlMobile' - 'rawHtml' - 'renderedHtml' - 'content')
    END,
    CASE WHEN f.swiped_data IS NULL THEN NULL ELSE
      (f.swiped_data - 'html' - 'mobileHtml' - 'htmlMobile' - 'rawHtml' - 'renderedHtml' - 'content')
    END,
    CASE WHEN f.extracted_data IS NULL THEN NULL ELSE
      (f.extracted_data - 'html' - 'mobileHtml' - 'htmlMobile' - 'rawHtml' - 'renderedHtml' - 'content')
    END,
    f.owner_user_id,
    f.created_at,
    f.updated_at
  FROM funnel_pages f
  ORDER BY f.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 5000));
$$;
GRANT EXECUTE ON FUNCTION public.slim_funnel_pages(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_funnel_pages(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_funnel_pages(int) TO anon;
`;

const LIST_COLS =
  'id, name, page_type, template_id, product_id, project_id, url_to_swipe, prompt, swipe_status, swipe_result, feedback, analysis_status, analysis_result, owner_user_id, created_at, updated_at';

function stubHtmlPointers(row: Record<string, unknown>): Record<string, unknown> {
  const id = String(row.id || '');
  const pointer = (kind: string) =>
    id ? `/api/funnel-html?pageId=${encodeURIComponent(id)}&kind=${kind}&variant=desktop` : undefined;
  const attach = (key: string, kind: string) => {
    const blob = row[key];
    if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
      const b = { ...(blob as Record<string, unknown>) };
      for (const k of HTML_KEYS) delete b[k];
      if (typeof b.htmlUrl !== 'string') b.htmlUrl = pointer(kind);
      b.htmlSkipped = true;
      row[key] = b;
      return;
    }
    row[key] = { htmlUrl: pointer(kind), htmlSkipped: true };
  };
  attach('cloned_data', 'cloned');
  attach('swiped_data', 'swiped');
  attach('extracted_data', 'extracted');
  return row;
}

async function ensureSlimFn(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql: CREATE_SLIM_FN });
  if (error) console.warn('[slim-funnel-pages] could not create RPC:', error.message);
}

export async function loadSlimFunnelPages(): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  let { data, error } = await supabaseAdmin.rpc('slim_funnel_pages', { p_limit: 2000 });
  if (error && /does not exist|42883/i.test(error.message || '')) {
    await ensureSlimFn();
    const retry = await supabaseAdmin.rpc('slim_funnel_pages', { p_limit: 2000 });
    data = retry.data;
    error = retry.error;
  }

  if (!error && Array.isArray(data)) {
    return {
      rows: data.map((r) => stubHtmlPointers({ ...(r as Record<string, unknown>) })),
      error: null,
    };
  }

  if (error) console.warn('[slim-funnel-pages] RPC failed, metadata fallback:', error.message);

  const fallback = await supabaseAdmin
    .from('funnel_pages')
    .select(LIST_COLS)
    .order('created_at', { ascending: true });
  if (fallback.error) return { rows: [], error: fallback.error.message };
  return {
    rows: (fallback.data || []).map((r) => stubHtmlPointers({ ...(r as Record<string, unknown>) })),
    error: null,
  };
}
