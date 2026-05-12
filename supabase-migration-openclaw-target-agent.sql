-- Migration: route OpenClaw queue messages to a SPECIFIC agent.
--
-- Without this column the openclaw_messages queue is "first worker
-- wins": every worker (Neo, Morfeo, ...) polls the same pending rows
-- and races for them. With `target_agent`, a row can be claimed only
-- by a worker whose OPENCLAW_MODEL env var matches.
--
-- Backward-compat: rows with target_agent = NULL stay first-come-
-- first-served, so existing flows (chat, swipe_job, rewrite) keep
-- working without changes on the worker side.

ALTER TABLE openclaw_messages
  ADD COLUMN IF NOT EXISTS target_agent TEXT;

-- Composite index that covers the worker's poll query
-- (status='pending' + target_agent IS NULL OR matches my model).
CREATE INDEX IF NOT EXISTS idx_openclaw_messages_pending_target
  ON openclaw_messages(status, target_agent, created_at)
  WHERE status IN ('pending', 'processing');

-- Force PostgREST to refresh its schema cache so the new column is
-- visible to the JS client immediately (otherwise inserts fail with
-- "Could not find the 'target_agent' column ..." until the next
-- automatic reload, ~10 minutes).
NOTIFY pgrst, 'reload schema';
