-- Migration: add per-section file storage to projects.
--
-- We keep the existing `brief` TEXT column intact so every reader that
-- already does `project.brief` (string) keeps working — we just store the
-- concatenated text of all uploaded files there.
--
-- File metadata + per-file extracted text live in a new JSONB column.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS brief_files JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The other section columns (market_research, compliance_funnel, funnel)
-- are already JSONB. The new shape we'll write to them is:
--   { "files": [...], "notes": "...", "content": "concat for back-compat" }
-- Old rows with shape { "content": "..." } are still readable.
