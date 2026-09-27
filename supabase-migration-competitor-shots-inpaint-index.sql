-- =====================================================
-- Index for the subtitle-cleanup queue on competitor_shots.
--
-- video-pipeline-scheduled (every 5 min) and inpaint-shot-background look up
-- shots by inpaint_status ('pending' / 'error'). With no index each lookup
-- scanned the whole table (~24k rows, 15 MB): up to 7.7 s per query in
-- pg_stat_statements. The partial index only holds shots still in the queue,
-- so it stays tiny.
-- Safe to run multiple times.
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_competitor_shots_inpaint_queue
  ON competitor_shots (inpaint_status, id)
  WHERE inpaint_status IN ('pending', 'processing', 'error');
