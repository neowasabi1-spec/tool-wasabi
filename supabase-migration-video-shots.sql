-- =====================================================
-- Phase 2: recreate videos from REAL competitor footage.
-- We segment saved competitor videos into individual "shots" (b-roll
-- pieces), flag which ones carry burned-in subtitles, and later mix the
-- clean pieces together under a new script/voice.
--
-- Heavy ffmpeg work runs in a standalone local worker
-- (video-segment-worker.js), fed by a job queue table.
-- Safe to run multiple times (IF NOT EXISTS).
-- =====================================================

-- Job queue: "segment this competitor video into shots".
CREATE TABLE IF NOT EXISTS video_segment_jobs (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  brand_id     BIGINT NOT NULL,
  ad_id        BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|error
  error        TEXT,
  shots_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_video_segment_jobs_status ON video_segment_jobs(status);
CREATE INDEX IF NOT EXISTS idx_video_segment_jobs_ad ON video_segment_jobs(ad_id);

-- Extracted shots: one row per cut, pointing at a stored clip + thumbnail.
CREATE TABLE IF NOT EXISTS competitor_shots (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  brand_id     BIGINT NOT NULL,
  ad_id        BIGINT NOT NULL,             -- source competitor_ads row
  file_path    TEXT NOT NULL,               -- clip in the project-files bucket
  thumb_path   TEXT,                        -- midpoint frame jpg
  start_sec    DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_sec      DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  width        INTEGER,
  height       INTEGER,
  -- Subtitle / burned-in text detection (so we can prefer clean shots and
  -- cover residual text with our own captions).
  has_text     BOOLEAN,                     -- NULL = not analyzed yet
  text_score   DOUBLE PRECISION,            -- 0..1 confidence of burned-in text
  text_region  TEXT,                        -- 'bottom'|'top'|'center'|'' hint
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_shots_project ON competitor_shots(project_id);
CREATE INDEX IF NOT EXISTS idx_competitor_shots_brand ON competitor_shots(brand_id);
CREATE INDEX IF NOT EXISTS idx_competitor_shots_ad ON competitor_shots(ad_id);
CREATE INDEX IF NOT EXISTS idx_competitor_shots_clean ON competitor_shots(has_text);
