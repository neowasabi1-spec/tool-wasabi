-- =====================================================
-- Localize an existing creative video: keep the original footage, swap in a
-- translated voiceover + subtitles. Reuses the video_build_jobs queue with a
-- `mode` discriminator ('build' = compose from the shot pool, 'localize' = dub
-- the source video at `source_path`). Safe to run multiple times.
-- =====================================================

ALTER TABLE video_build_jobs ADD COLUMN IF NOT EXISTS mode        TEXT NOT NULL DEFAULT 'build';
ALTER TABLE video_build_jobs ADD COLUMN IF NOT EXISTS source_path TEXT;
