-- =====================================================
-- SHARED TEMPLATE LIBRARY (swipe_templates) — read for everyone
-- =====================================================
--
-- Problem: with the multi-tenancy phase-2 RLS, swipe_templates SELECT was
-- restricted to (owner = auth.uid() OR is_master()). All the existing
-- templates are owned by the master (owner_user_id = get_master_id()),
-- so regular users only saw the few templates THEY created — e.g. a user
-- saw 4 templates while the master saw all 19 when adding a quiz step.
--
-- swipe_templates is meant to be a SHARED CATALOG: every authenticated
-- user must be able to READ (and therefore swipe from) the whole library,
-- but only the owner or the master may INSERT / UPDATE / DELETE.
--
-- This migration relaxes ONLY the SELECT policy:
--   - your own templates              (owner_user_id = auth.uid())
--   - the master's shared library     (owner_user_id = get_master_id())
--   - master sees everything          (is_master(auth.uid()))
--   - anon/server contexts            (auth.uid() IS NULL)
-- Write policies stay owner/master-only (unchanged).
--
-- Idempotent: safe to run multiple times.

DROP POLICY IF EXISTS "swipe_templates_owner_or_master_select" ON public.swipe_templates;
DROP POLICY IF EXISTS "swipe_templates_shared_read" ON public.swipe_templates;

CREATE POLICY "swipe_templates_shared_read" ON public.swipe_templates FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR owner_user_id = public.get_master_id()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
  );

-- Write policies are left untouched. They were created by
-- supabase-migration-multi-tenancy.sql as:
--   swipe_templates_owner_or_master_insert
--   swipe_templates_owner_or_master_update
--   swipe_templates_owner_or_master_delete
-- and keep mutations restricted to owner or master.
