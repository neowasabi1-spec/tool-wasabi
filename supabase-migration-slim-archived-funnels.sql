-- Strip cloned_data.html when listing Competitor Landings / Chimera funnels.
-- Selecting the raw `steps` JSONB (full page HTML per step) times out
-- Postgres and can stall the Supabase project.
-- Safe to run multiple times.

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
