-- =====================================================================
-- MULTI-TENANCY ROLLBACK — undo phase 1 (and phase 2 if applied)
-- =====================================================================
-- Run this in Supabase Studio → SQL Editor if you need to revert the
-- multi-tenancy migration. It is IDEMPOTENT and SAFE — it only drops
-- things that exist, never errors if they're missing.
--
-- After this runs, every migrated table is back to its pre-migration
-- shape: no owner_user_id column, no trigger, no RLS policies, RLS
-- disabled. The trigger functions (is_master, get_master_id,
-- auto_owner_user_id) are removed too.
-- =====================================================================

BEGIN;

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
    -- 1. Disable RLS (silently no-op if table missing)
    EXECUTE format('ALTER TABLE IF EXISTS public.%I DISABLE ROW LEVEL SECURITY;', t);

    -- 2. Drop the 4 owner_or_master policies
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_select" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_insert" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_update" ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_owner_or_master_delete" ON public.%I;', t, t);

    -- 3. Drop the auto-owner BEFORE INSERT trigger
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_auto_owner ON public.%I;', t, t);

    -- 4. Drop the owner_user_id column (CASCADE in case any view
    --    references it, which is the safest default for rollback).
    EXECUTE format('ALTER TABLE IF EXISTS public.%I DROP COLUMN IF EXISTS owner_user_id CASCADE;', t);

    -- 5. Drop the owner index (idempotent, may not exist if dropped
    --    automatically with the column).
    EXECUTE format('DROP INDEX IF EXISTS public.%I_owner_user_id_idx;', t);
  END LOOP;
END $$;

-- Remove the shared helper functions LAST (nothing else should depend
-- on them after the table-level cleanup above).
DROP FUNCTION IF EXISTS public.auto_owner_user_id() CASCADE;
DROP FUNCTION IF EXISTS public.is_master(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_master_id() CASCADE;

COMMIT;

-- =====================================================================
-- DONE. Database is back to the pre-multi-tenancy state.
--   * No RLS on any of the 24 migrated tables.
--   * No owner_user_id columns.
--   * No triggers or helper functions related to ownership.
-- The application code on `main` continues to work because it never
-- relied on these columns.
-- =====================================================================
