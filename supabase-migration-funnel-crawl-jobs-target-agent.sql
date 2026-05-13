-- Route a funnel_crawl_jobs row to a specific agent's worker
-- (openclaw:neo on the Windows PC vs openclaw:morfeo on the Mac Mini).
--
-- Without this column every running worker would race for every
-- pending crawl job. With it, the UI picks "Neo" or "Morfeo" and only
-- that agent's worker can claim the row — same pattern already used
-- by openclaw_messages (see supabase-migration-openclaw-target-agent.sql).
--
-- Backward-compat: rows with target_agent = NULL stay first-come-
-- first-served, so any pre-existing pending job keeps working.

ALTER TABLE funnel_crawl_jobs
  ADD COLUMN IF NOT EXISTS target_agent TEXT;

-- Composite index for the worker's poll query
-- (status='pending' AND (target_agent IS NULL OR target_agent = mine)).
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_jobs_pending_target
  ON funnel_crawl_jobs(status, target_agent, created_at)
  WHERE status IN ('pending', 'running');

-- Force PostgREST to refresh its schema cache so the new column is
-- visible to the JS client immediately (otherwise inserts fail with
-- "Could not find the 'target_agent' column ...").
NOTIFY pgrst, 'reload schema';
