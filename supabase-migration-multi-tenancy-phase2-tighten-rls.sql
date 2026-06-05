-- =====================================================================
-- MULTI-TENANCY MIGRATION — PHASE 2 (tighten RLS, enforce isolation)
-- =====================================================================
-- ⚠️ DO NOT RUN UNTIL ALL SERVER-SIDE ANON ROUTES HAVE BEEN MIGRATED
-- to either:
--   (a) attach the caller's JWT to the supabase client, OR
--   (b) use `supabaseAdmin` and set owner_user_id explicitly.
--
-- This file DROPS the temporary `OR auth.uid() IS NULL` fallback that
-- phase 1 added to keep legacy server-side anon callers working. Once
-- this runs, any server-side anon call WITHOUT a user JWT will be
-- denied by RLS (rows return empty / writes fail). That is the intent.
--
-- Verification BEFORE running:
--   * grep `from '@/lib/supabase'` in src/app/api → every result must
--     either (i) have been replaced with `supabaseAdmin` + explicit
--     `owner_user_id`, or (ii) use a user-JWT-aware client.
--   * Test as both master and a regular user that all sections still
--     load data.
--
-- This migration is IDEMPOTENT: re-running it is safe.
-- =====================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- Helper to recreate all 4 policies for a given table with the strict
-- (no anon fallback) condition.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'projects', 'products', 'funnel_pages', 'swipe_templates',
    'archived_funnels', 'saved_prompts', 'openclaw_messages',
    'funnel_crawl_jobs', 'affiliate_saved_funnels',
    'affiliate_browser_chats', 'scheduled_browser_jobs',
    'quiz_archive', 'multiagent_jobs', 'cloning_jobs',
    'checkpoint_funnels', 'funnel_flows', 'page_html',
    'project_files', 'funnel_steps', 'post_purchase_pages',
    'funnel_crawl_steps', 'cloning_texts', 'funnel_checkpoints',
    'flow_steps'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_select" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_insert" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_update" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_delete" ON public.%I;', t, t);

    EXECUTE format($f$
      CREATE POLICY "%I_owner_or_master_select" ON public.%I FOR SELECT
        USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()));
    $f$, t, t);
    EXECUTE format($f$
      CREATE POLICY "%I_owner_or_master_insert" ON public.%I FOR INSERT
        WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()));
    $f$, t, t);
    EXECUTE format($f$
      CREATE POLICY "%I_owner_or_master_update" ON public.%I FOR UPDATE
        USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()))
        WITH CHECK (owner_user_id = auth.uid() OR public.is_master(auth.uid()));
    $f$, t, t);
    EXECUTE format($f$
      CREATE POLICY "%I_owner_or_master_delete" ON public.%I FOR DELETE
        USING (owner_user_id = auth.uid() OR public.is_master(auth.uid()));
    $f$, t, t);
  END LOOP;
END $$;

COMMIT;

-- =====================================================================
-- DONE — PHASE 2 APPLIED. Strict isolation now enforced:
--   * Only the owner sees / writes own rows.
--   * Master sees / writes everything.
--   * Service role still bypasses RLS (server-side admin context).
--   * Anonymous / unauthenticated calls are denied on every owned table.
--
-- ROLLBACK to phase-1 (re-add the auth.uid() IS NULL fallback): just
-- re-run `supabase-migration-multi-tenancy.sql` — it's idempotent and
-- the CREATE POLICY statements there include the fallback clause.
-- =====================================================================
