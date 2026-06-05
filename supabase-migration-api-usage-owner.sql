-- ─────────────────────────────────────────────────────────────────────
-- Per-user breakdown of LLM spend
-- ─────────────────────────────────────────────────────────────────────
-- Adds owner_user_id to api_usage_log so the /api-usage dashboard can
-- show which user triggered each LLM call. The Mac-mini worker reads
-- jobs from openclaw_messages (already carrying owner_user_id from the
-- multi-tenancy phase 1) and now propagates it to every cost row.
--
-- Old rows stay NULL — they predate multi-tenancy and the dashboard
-- buckets them under "Unattributed".
--
-- We keep the existing permissive RLS on api_usage_log: the dashboard
-- route uses the service-role admin client and applies the per-user /
-- master-sees-all filter manually (canonical pattern, see the other
-- multi-tenancy migration files).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.api_usage_log
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Speeds up "byUser breakdown for last 30 days" without locking the
-- whole table on writes (append-only, partial index keeps it tiny).
CREATE INDEX IF NOT EXISTS idx_api_usage_log_owner_recent
  ON public.api_usage_log(owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;

COMMIT;
