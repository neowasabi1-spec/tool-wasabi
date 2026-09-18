-- Fast listing for Template → Pages.
-- Does not return cloned_data.html (that blob is what timed out
-- /api/valchiria/funnels on Netlify: "the edge function timed out").
-- Safe to run multiple times.

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
    AND (COALESCE(f.section, '') = 'page' OR COALESCE(f.total_steps, 1) <= 1)
  ORDER BY f.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 40), 80))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slim_template_pages(int, int) TO anon;
