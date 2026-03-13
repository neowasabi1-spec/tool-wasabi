-- =====================================================
-- MULTIAGENT JOBS TABLE
-- Background jobs for the multi-agent quiz generation pipeline
-- =====================================================

CREATE TABLE IF NOT EXISTS multiagent_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','cloning','screenshots','analyzing','branding','transforming','completed','failed')),
  entry_url TEXT NOT NULL,
  funnel_name TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}',
  progress JSONB NOT NULL DEFAULT '[]',
  master_spec JSONB,
  branding JSONB,
  result_html TEXT,
  error TEXT,
  usage JSONB,
  current_phase TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_multiagent_jobs_status ON multiagent_jobs(status);
CREATE INDEX IF NOT EXISTS idx_multiagent_jobs_created_at ON multiagent_jobs(created_at DESC);

ALTER TABLE multiagent_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on multiagent_jobs"
  ON multiagent_jobs FOR ALL USING (true) WITH CHECK (true);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS update_multiagent_jobs_updated_at ON multiagent_jobs;
CREATE TRIGGER update_multiagent_jobs_updated_at
  BEFORE UPDATE ON multiagent_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
