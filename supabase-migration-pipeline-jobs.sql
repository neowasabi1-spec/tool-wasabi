-- =====================================================
-- PIPELINE JOBS TABLE  (Project Autopilot)
-- Orchestrator + queue for the automated project pipeline:
--   product + competitor link + description
--     -> market research -> brief -> competitor -> ads -> landing
-- Each step persists its output into the project (Supabase), so the
-- LLM never has to "remember" prior steps — the state lives here + in
-- the projects tables. Steps are driven sequentially by the Netlify
-- background function `pipeline-run-background`.
-- =====================================================

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id    UUID NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id UUID NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','canceled')),
  -- { product, competitorLink, description, language }
  input         JSONB NOT NULL DEFAULT '{}',
  -- [{ key, label, status, summary, output, error, startedAt, finishedAt }]
  steps         JSONB NOT NULL DEFAULT '[]',
  current_step  TEXT NULL,
  error         TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_project_id ON pipeline_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status     ON pipeline_jobs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_created_at ON pipeline_jobs(created_at DESC);

ALTER TABLE pipeline_jobs ENABLE ROW LEVEL SECURITY;

-- Same permissive policy pattern used by multiagent_jobs / automation_jobs:
-- access is re-checked in code (service-role) via getUserAccessContext.
DROP POLICY IF EXISTS "Allow all operations on pipeline_jobs" ON pipeline_jobs;
CREATE POLICY "Allow all operations on pipeline_jobs"
  ON pipeline_jobs FOR ALL USING (true) WITH CHECK (true);

-- Auto-update updated_at. The shared trigger fn already exists in
-- supabase-schema.sql, but we (re)create it defensively so this file can
-- also be run standalone in a fresh database.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_pipeline_jobs_updated_at ON pipeline_jobs;
CREATE TRIGGER update_pipeline_jobs_updated_at
  BEFORE UPDATE ON pipeline_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
