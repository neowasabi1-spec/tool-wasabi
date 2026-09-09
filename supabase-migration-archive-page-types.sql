-- Migration: user-defined archive page types (funnel steps beyond the built-ins).
--
-- Built-in types (Landing, Upsell 1–3, …) stay in BUILT_IN_PAGE_TYPE_OPTIONS.
-- This table is the "known extra types" list so a user can add Upsell 4,
-- Webinar Replay, etc. from the browser extension or Templates, and a matching
-- By Type folder appears in My Archive. The type value is also stored inline
-- on each archived_funnels step (`page_type`).

CREATE TABLE IF NOT EXISTS public.archive_page_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, value)
);

CREATE INDEX IF NOT EXISTS archive_page_types_owner_idx
  ON public.archive_page_types(owner_user_id);

ALTER TABLE public.archive_page_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archive_page_types_owner_or_master_select" ON public.archive_page_types;
DROP POLICY IF EXISTS "archive_page_types_owner_or_master_insert" ON public.archive_page_types;
DROP POLICY IF EXISTS "archive_page_types_owner_or_master_update" ON public.archive_page_types;
DROP POLICY IF EXISTS "archive_page_types_owner_or_master_delete" ON public.archive_page_types;

CREATE POLICY "archive_page_types_owner_or_master_select" ON public.archive_page_types FOR SELECT
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_page_types_owner_or_master_insert" ON public.archive_page_types FOR INSERT
  WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_page_types_owner_or_master_update" ON public.archive_page_types FOR UPDATE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
CREATE POLICY "archive_page_types_owner_or_master_delete" ON public.archive_page_types FOR DELETE
  USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()) OR auth.uid() IS NULL);
