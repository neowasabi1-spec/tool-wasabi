-- Migrazione: tabella funnel_crawl_steps (Funnel Analyzer) con nome e tag
-- Esegui in Supabase SQL Editor se il DB esiste già

-- Se la tabella esiste già senza funnel_name/funnel_tag, aggiungi le colonne:
-- ALTER TABLE funnel_crawl_steps ADD COLUMN IF NOT EXISTS funnel_name TEXT NOT NULL DEFAULT '';
-- ALTER TABLE funnel_crawl_steps ADD COLUMN IF NOT EXISTS funnel_tag TEXT;
-- CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_name ON funnel_crawl_steps(funnel_name);
-- CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_tag ON funnel_crawl_steps(funnel_tag);

CREATE TABLE IF NOT EXISTS funnel_crawl_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funnel_name TEXT NOT NULL DEFAULT '',
  funnel_tag TEXT,
  entry_url TEXT NOT NULL,
  step_index INT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  step_data JSONB NOT NULL DEFAULT '{}',
  screenshot_base64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_entry_url ON funnel_crawl_steps(entry_url);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_created_at ON funnel_crawl_steps(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_name ON funnel_crawl_steps(funnel_name);
CREATE INDEX IF NOT EXISTS idx_funnel_crawl_steps_funnel_tag ON funnel_crawl_steps(funnel_tag);

ALTER TABLE funnel_crawl_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on funnel_crawl_steps" ON funnel_crawl_steps FOR ALL USING (true) WITH CHECK (true);
