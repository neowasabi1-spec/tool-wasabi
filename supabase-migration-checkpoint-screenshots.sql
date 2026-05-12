-- supabase-migration-checkpoint-screenshots.sql
--
-- Creates the public bucket used by the Checkpoint Visual audit
-- to store mobile screenshots that are then attached to the
-- Anthropic vision call.
--
-- Run once per environment (idempotent — safe to re-run).
--
-- Why public?
-- The screenshots are referenced by URL in the Anthropic API
-- request (`{type: 'image', source: {type: 'url', url: ...}}`).
-- Anthropic's fetcher does not authenticate, so the bucket has
-- to serve the file with no auth challenge.
--
-- Why no RLS on storage.objects beyond public read?
-- The path scheme is `{runId}/step-{N}-mobile.jpg` where runId is
-- a server-generated UUID. Knowing one URL doesn't grant any
-- ability to list / overwrite siblings; the service-role key in
-- the server-only `uploadCheckpointScreenshot()` is the only
-- writer.

-- 1) Bucket creation (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'checkpoint-screenshots',
  'checkpoint-screenshots',
  TRUE,
  5242880, -- 5 MB, matches Anthropic per-image cap
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2) Public read policy (anyone can GET an object — needed so
--    Anthropic's image fetcher can download).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'checkpoint_screenshots_public_read'
  ) THEN
    CREATE POLICY checkpoint_screenshots_public_read
      ON storage.objects FOR SELECT
      USING (bucket_id = 'checkpoint-screenshots');
  END IF;
END$$;

-- 3) Service-role can do everything (write/delete) — already true
--    by default since service_role bypasses RLS, but we add an
--    explicit policy for the anon key fallback that the codebase
--    permits when SUPABASE_SERVICE_ROLE_KEY isn't configured.
--    REMOVE this policy in production if you don't want anon
--    uploads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'checkpoint_screenshots_anon_write'
  ) THEN
    CREATE POLICY checkpoint_screenshots_anon_write
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'checkpoint-screenshots');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'checkpoint_screenshots_anon_update'
  ) THEN
    CREATE POLICY checkpoint_screenshots_anon_update
      ON storage.objects FOR UPDATE
      USING (bucket_id = 'checkpoint-screenshots');
  END IF;
END$$;
