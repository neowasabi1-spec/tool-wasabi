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
