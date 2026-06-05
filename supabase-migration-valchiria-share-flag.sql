-- ─────────────────────────────────────────────────────────────────────
-- Valchiria: separate "show in my Valchiria" from "share with users"
-- ─────────────────────────────────────────────────────────────────────
-- Follow-up to supabase-migration-valchiria-shared.sql.
--
-- The first migration coupled two ideas into one column
-- (`show_in_valchiria`):
--   1. Whether the row owner sees it in their own /protocollo-valchiria
--   2. Whether the row is part of the master's shared library that
--      every other authenticated user can pull from
--
-- The master needs them separate: turning on a personal funnel inside
-- their own Valchiria should NOT automatically publish it to every
-- collaborator. This migration introduces a dedicated `share_with_users`
-- column and migrates the RLS policy to read it instead.
--
-- Semantics after this migration:
--   show_in_valchiria     → personal visibility on /protocollo-valchiria
--                           (every user can toggle on their own rows)
--   share_with_users      → master-only opt-in switch. When TRUE on a
--                           master-owned row, every other authenticated
--                           user sees that row read-only in their
--                           Valchiria + My Archive.
--
-- Default for `share_with_users` is FALSE. We do NOT backfill it from
-- existing rows — the master must explicitly opt in funnel by funnel
-- (which is the whole reason for this migration).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) New column ─────────────────────────────────────────────────────
ALTER TABLE public.archived_funnels
  ADD COLUMN IF NOT EXISTS share_with_users BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Index — speeds up the shared-library lookup
--    (WHERE share_with_users = TRUE AND owner_user_id = master_id).
CREATE INDEX IF NOT EXISTS archived_funnels_share_idx
  ON public.archived_funnels(share_with_users, owner_user_id)
  WHERE share_with_users = TRUE;

-- 3) Replace the shared-library RLS policy created by the previous
--    migration so it reads the new flag. The policy created in
--    supabase-migration-valchiria-shared.sql was named
--    "archived_funnels_shared_library_select" and gated on
--    show_in_valchiria — we drop and recreate it.
DROP POLICY IF EXISTS "archived_funnels_shared_library_select" ON public.archived_funnels;
CREATE POLICY "archived_funnels_shared_library_select"
  ON public.archived_funnels
  FOR SELECT
  USING (
    share_with_users = TRUE
    AND owner_user_id = public.get_master_id()
  );

-- 4) Sanity check counts so operators can verify in the log
DO $$
DECLARE
  total INTEGER;
  shared INTEGER;
BEGIN
  SELECT COUNT(*) INTO total FROM public.archived_funnels;
  SELECT COUNT(*) INTO shared
    FROM public.archived_funnels
   WHERE share_with_users = TRUE
     AND owner_user_id = public.get_master_id();
  RAISE NOTICE 'archived_funnels: % total rows, % currently shared with users by master.',
    total, shared;
END $$;

COMMIT;
