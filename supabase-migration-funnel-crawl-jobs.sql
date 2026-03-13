-- Job in background per Funnel Analyzer crawl (nessun timeout HTTP)
CREATE TABLE IF NOT EXISTS funnel_crawl_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  entry_url TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error TEXT,
  current_step INT DEFAULT 0,
  total_steps INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_crawl_jobs_status ON funnel_crawl_jobs(status);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_jobs_created_at ON funnel_crawl_jobs(created_at DESC);

ALTER TABLE funnel_crawl_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on funnel_crawl_jobs" ON funnel_crawl_jobs FOR ALL USING (true) WITH CHECK (true);
