-- Front End Funnel step order. Lower sort_order is the first page.
-- Nullable so existing rows keep created_at order until the user moves a step.
-- The app also applies this via exec_sql on the first reorder.

ALTER TABLE public.funnel_pages
  ADD COLUMN IF NOT EXISTS sort_order integer;

NOTIFY pgrst, 'reload schema';
