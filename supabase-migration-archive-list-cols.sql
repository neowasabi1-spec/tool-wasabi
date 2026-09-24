-- Lightweight listing fields for Templates → Pages.
-- `archived_funnels.steps` still holds 1–5 MB of HTML per page; selecting
-- that jsonb is what timed out /api/valchiria/funnels.
-- Safe to run multiple times.

ALTER TABLE public.archived_funnels
  ADD COLUMN IF NOT EXISTS list_page_type text,
  ADD COLUMN IF NOT EXISTS list_source_url text,
  ADD COLUMN IF NOT EXISTS list_shot text,
  ADD COLUMN IF NOT EXISTS list_shot_mobile text,
  ADD COLUMN IF NOT EXISTS list_html_url text,
  ADD COLUMN IF NOT EXISTS list_tags jsonb,
  ADD COLUMN IF NOT EXISTS list_geo text,
  ADD COLUMN IF NOT EXISTS list_category text;

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
WHERE f.project_id IS NULL
  AND (f.list_page_type IS NULL OR btrim(f.list_page_type) = '');
