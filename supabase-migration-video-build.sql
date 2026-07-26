-- =====================================================
-- Phase 2 step 2: assemble a NEW video from real competitor shots.
-- A build job carries the rewritten script split into scenes; the local
-- worker synthesizes a voiceover (OpenAI TTS), fills each scene with CLEAN
-- shots from the pool, burns our own subtitles, and outputs an mp4.
-- Safe to run multiple times (IF NOT EXISTS).
-- =====================================================

CREATE TABLE IF NOT EXISTS video_build_jobs (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  brand_id     BIGINT NOT NULL DEFAULT 0,
  ad_id        BIGINT NOT NULL DEFAULT 0,   -- source creative (for the script)
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|error
  error        TEXT,
  voice        TEXT NOT NULL DEFAULT 'alloy',
  scenes       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ "text": "..." }, ...]
  result_id    BIGINT,                      -- generated_videos.id when done
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_video_build_jobs_status ON video_build_jobs(status);

CREATE TABLE IF NOT EXISTS generated_videos (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  brand_id     BIGINT NOT NULL DEFAULT 0,
  ad_id        BIGINT NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL,               -- final mp4 in project-files
  thumb_path   TEXT,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  script       TEXT,
  voice        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_videos_project ON generated_videos(project_id);
CREATE INDEX IF NOT EXISTS idx_generated_videos_ad ON generated_videos(ad_id);
