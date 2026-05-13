-- API Usage Log: every paid LLM call writes one row here so the
-- /api-usage dashboard can show running totals (today / this week /
-- this month / all time) and per-provider / per-source breakdowns.
--
-- Designed for append-only writes. Cost is precomputed at insert time
-- (cents/1M tokens × token counts) so the dashboard can SUM(cost_usd)
-- without re-running the pricing logic on every read.
--
-- Indexes on created_at, provider, source so the typical aggregation
-- queries (GROUP BY provider WHERE created_at >= now() - interval) are
-- fast even after months of rows.

CREATE TABLE IF NOT EXISTS api_usage_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider        TEXT NOT NULL,                            -- 'anthropic' | 'openai' | 'gemini' | ...
  model           TEXT NOT NULL,                            -- e.g. 'claude-sonnet-4-20250514'
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0,
  source          TEXT,                                      -- 'checkpoint_audit' | 'funnel_crawl' | 'swipe' | 'rewrite' | 'chat' | ...
  agent           TEXT,                                      -- 'openclaw:neo' | 'openclaw:morfeo' | NULL when called from a Netlify route
  duration_ms     INT,                                       -- optional: how long the API call took
  metadata        JSONB                                      -- optional: { runId, funnelId, ... } for tracing
);

CREATE INDEX IF NOT EXISTS idx_api_usage_log_created_at ON api_usage_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_log_provider   ON api_usage_log(provider);
CREATE INDEX IF NOT EXISTS idx_api_usage_log_source     ON api_usage_log(source);

ALTER TABLE api_usage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on api_usage_log" ON api_usage_log;
CREATE POLICY "Allow all operations on api_usage_log" ON api_usage_log FOR ALL USING (true) WITH CHECK (true);
