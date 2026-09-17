-- Migration: shared Ads template library on the Template page.
--
-- Mirrors Pages (archive_page_types + archived_funnels) for creatives:
--   - archive_ad_types  → extra folders ("Hook", "Testimonial", …)
--   - archive_ads       → image/video templates grouped by ad_type
--                         and optionally tagged with a niche `category`
--                         (same archive_categories list as landings).
--
-- Built-in folders (Image, Video, Carousel, UGC, Story) live in
-- BUILT_IN_AD_TYPE_OPTIONS and do not need rows here.

CREATE TABLE IF NOT EXISTS public.archive_ad_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, value)
);

CREATE INDEX IF NOT EXISTS archive_ad_types_owner_idx
  ON public.archive_ad_types(owner_user_id);

ALTER TABLE public.archive_ad_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archive_ad_types_owner_or_master_select" ON public.archive_ad_types;
DROP POLICY IF EXISTS "archive_ad_types_owner_or_master_insert" ON public.archive_ad_types;
DROP POLICY IF EXISTS "archive_ad_types_owner_or_master_update" ON public.archive_ad_types;
DROP POLICY IF EXISTS "archive_ad_types_owner_or_master_delete" ON public.archive_ad_types;

CREATE POLICY "archive_ad_types_owner_or_master_select" ON public.archive_ad_types FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ad_types_owner_or_master_insert" ON public.archive_ad_types FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ad_types_owner_or_master_update" ON public.archive_ad_types FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ad_types_owner_or_master_delete" ON public.archive_ad_types FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);

CREATE TABLE IF NOT EXISTS public.archive_ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  ad_type TEXT NOT NULL DEFAULT 'image',
  category TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'image',
  file_path TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  primary_text TEXT NOT NULL DEFAULT '',
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_ads_type_idx ON public.archive_ads(ad_type);
CREATE INDEX IF NOT EXISTS archive_ads_category_idx ON public.archive_ads(category);
CREATE INDEX IF NOT EXISTS archive_ads_owner_idx ON public.archive_ads(owner_user_id);
CREATE INDEX IF NOT EXISTS archive_ads_created_idx ON public.archive_ads(created_at DESC);

ALTER TABLE public.archive_ads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archive_ads_shared_select" ON public.archive_ads;
DROP POLICY IF EXISTS "archive_ads_owner_or_master_insert" ON public.archive_ads;
DROP POLICY IF EXISTS "archive_ads_owner_or_master_update" ON public.archive_ads;
DROP POLICY IF EXISTS "archive_ads_owner_or_master_delete" ON public.archive_ads;

-- Shared library: every signed-in user can see every ad template.
CREATE POLICY "archive_ads_shared_select" ON public.archive_ads FOR SELECT
  USING (auth.uid() IS NOT NULL OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ads_owner_or_master_insert" ON public.archive_ads FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ads_owner_or_master_update" ON public.archive_ads FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_ads_owner_or_master_delete" ON public.archive_ads FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
