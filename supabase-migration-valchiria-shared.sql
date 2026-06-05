-- ─────────────────────────────────────────────────────────────────────
-- Valchiria shared library
-- ─────────────────────────────────────────────────────────────────────
-- Goal: let any logged-in user pull a saved funnel into Protocollo
-- Valchiria from their own My Archive AND from the master's shared
-- library, replacing the legacy `[SWIPE]` naming convention.
--
-- Behaviour:
--   - A new boolean column `show_in_valchiria` on `archived_funnels`
--     defaults to FALSE.
--   - The owner (and the master) can toggle it from /templates.
--   - Rows owned by the master with `show_in_valchiria = TRUE` are
--     visible (read-only) to every other authenticated user — that is
--     the "shared library".
--   - Regular users keep full write access on their OWN rows; the
--     shared rows are read-only because the UPDATE/DELETE policies
--     remain owner-or-master.
--
-- The migration is IDEMPOTENT: re-running it is safe. The RLS policy
-- is CREATEd with a DROP IF EXISTS first so an in-place change works.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Column ─────────────────────────────────────────────────────────
ALTER TABLE public.archived_funnels
  ADD COLUMN IF NOT EXISTS show_in_valchiria BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Backfill: anything historically prefixed with [SWIPE] in the name
--    was the only way to surface a funnel in Valchiria, so promote
--    those rows to the new flag automatically. The legacy `[SWIPE]`
--    prefix in the name is left untouched — the UI no longer relies
--    on it but it stays readable.
UPDATE public.archived_funnels
   SET show_in_valchiria = TRUE
 WHERE name ILIKE '%[SWIPE]%'
   AND show_in_valchiria = FALSE;

-- 3) Index — speeds up the shared-library query
--    (WHERE show_in_valchiria = TRUE AND owner_user_id = get_master_id()).
CREATE INDEX IF NOT EXISTS archived_funnels_valchiria_idx
  ON public.archived_funnels(show_in_valchiria, owner_user_id)
  WHERE show_in_valchiria = TRUE;

-- 4) Additional SELECT policy: shared library
--    Postgres OR's PERMISSIVE policies on the same command, so this
--    one is *added* to the existing owner_or_master_select policy
--    without touching it. Any authenticated user can read a master-
--    owned row that's been flipped to show_in_valchiria.
DROP POLICY IF EXISTS "archived_funnels_shared_library_select" ON public.archived_funnels;
CREATE POLICY "archived_funnels_shared_library_select"
  ON public.archived_funnels
  FOR SELECT
  USING (
    show_in_valchiria = TRUE
    AND owner_user_id = public.get_master_id()
  );

-- 5) Sanity check: count what we promoted, so the migration log
--    shows operators a quick confirmation.
DO $$
DECLARE
  promoted INTEGER;
  shared INTEGER;
BEGIN
  SELECT COUNT(*) INTO promoted
    FROM public.archived_funnels
   WHERE show_in_valchiria = TRUE;
  SELECT COUNT(*) INTO shared
    FROM public.archived_funnels
   WHERE show_in_valchiria = TRUE
     AND owner_user_id = public.get_master_id();
  RAISE NOTICE 'archived_funnels.show_in_valchiria → % rows (% master-owned / shared).',
    promoted, shared;
END $$;

COMMIT;
