-- Migration: user-defined archive categories (niches/verticals).
--
-- The archive "By Type" view now has TWO dimensions:
--   - category  (user-defined niche: "Survival", "Weight loss", …)  ← this table
--   - page_type (Advertorial, VSL, TSL, …)                          ← BUILT_IN_PAGE_TYPE_OPTIONS
--
-- A saved page carries both. Categories are stored here so a user can create
-- them up-front (before any page uses them) and pick them in the app + the
-- browser extension. The category value itself is also stored inline on each
-- archived_funnels step, so this table is only the "known categories" list.

CREATE TABLE IF NOT EXISTS public.archive_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE INDEX IF NOT EXISTS archive_categories_owner_idx
  ON public.archive_categories(owner_user_id);

ALTER TABLE public.archive_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archive_categories_owner_or_master_select" ON public.archive_categories;
DROP POLICY IF EXISTS "archive_categories_owner_or_master_insert" ON public.archive_categories;
DROP POLICY IF EXISTS "archive_categories_owner_or_master_delete" ON public.archive_categories;

CREATE POLICY "archive_categories_owner_or_master_select" ON public.archive_categories FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_categories_owner_or_master_insert" ON public.archive_categories FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_categories_owner_or_master_delete" ON public.archive_categories FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
