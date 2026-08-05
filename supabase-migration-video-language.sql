-- =====================================================
-- Custom-copy / multilingual video builds.
-- A build is now driven by an arbitrary script + voice + (optional) language,
-- so a product's real shot pool can be reused for any copy and any geo. The
-- spoken language is recorded on the job and on the finished video so variants
-- can be told apart. Safe to run multiple times.
-- =====================================================

ALTER TABLE video_build_jobs ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE generated_videos  ADD COLUMN IF NOT EXISTS language TEXT;
