-- List funnel_pages without cloned_data.html (1–5 MB per row).
-- SELECT * on funnel_pages is what 57014-timeouts Postgres and freezes boot.
-- Safe to run multiple times.

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
