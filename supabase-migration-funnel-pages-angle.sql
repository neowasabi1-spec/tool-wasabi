-- Migration: add `angle` free-text column to funnel_pages.
--
-- The Front End Funnel table now exposes an "Angle" cell between URL and
-- Prompt so the user can record the marketing angle (e.g. "fear-of-loss",
-- "social proof", "before/after") for each step of the funnel.
--
-- The column is nullable + defaults to NULL so existing rows don't need
-- a backfill. The TypeScript layer also retries the update without
-- `angle` if Supabase reports the column is missing, so the UI keeps
-- working until this migration is applied.

ALTER TABLE funnel_pages
  ADD COLUMN IF NOT EXISTS angle TEXT NULL;
