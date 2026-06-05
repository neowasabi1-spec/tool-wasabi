-- ─────────────────────────────────────────────────────────────────────
-- Valchiria: per-user picks of master-shared funnels
-- ─────────────────────────────────────────────────────────────────────
-- Follow-up to:
--   supabase-migration-valchiria-shared.sql
--   supabase-migration-valchiria-share-flag.sql
--
-- Until now, when the master flipped `share_with_users = TRUE` on a
-- funnel, every authenticated user saw it automatically in their
-- Protocollo Valchiria. We want the opposite: shared funnels appear
-- in "My Archive" with a SHARED badge, and each user explicitly picks
-- which ones to put in their OWN Protocollo Valchiria.
--
-- We can't reuse `show_in_valchiria` because that flag is set on the
-- row itself and would be one-value-for-everybody. So we add a
-- dedicated junction table `valchiria_user_picks` that records, per
-- (user_id, funnel_id), that this user wants this shared funnel in
-- their personal Valchiria.
--
-- The user's OWN funnels keep using `show_in_valchiria` — picks are
-- only relevant for funnels they don't own.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.valchiria_user_picks (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  funnel_id  UUID        NOT NULL REFERENCES public.archived_funnels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, funnel_id)
);

CREATE INDEX IF NOT EXISTS valchiria_user_picks_user_idx
  ON public.valchiria_user_picks(user_id);

CREATE INDEX IF NOT EXISTS valchiria_user_picks_funnel_idx
  ON public.valchiria_user_picks(funnel_id);

-- 2) RLS — each user only sees/manages their own picks. The master
--    is just another user here: they don't need picks because they
--    own everything they could care to pin. We don't grant them an
--    "is_master(...) OR ..." escape so the master's UI stays simple.
ALTER TABLE public.valchiria_user_picks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "valchiria_user_picks_select" ON public.valchiria_user_picks;
DROP POLICY IF EXISTS "valchiria_user_picks_insert" ON public.valchiria_user_picks;
DROP POLICY IF EXISTS "valchiria_user_picks_delete" ON public.valchiria_user_picks;

CREATE POLICY "valchiria_user_picks_select"
  ON public.valchiria_user_picks
  FOR SELECT
  USING (user_id = auth.uid() OR auth.uid() IS NULL);

CREATE POLICY "valchiria_user_picks_insert"
  ON public.valchiria_user_picks
  FOR INSERT
  WITH CHECK (user_id = auth.uid() OR auth.uid() IS NULL);

CREATE POLICY "valchiria_user_picks_delete"
  ON public.valchiria_user_picks
  FOR DELETE
  USING (user_id = auth.uid() OR auth.uid() IS NULL);

COMMIT;
