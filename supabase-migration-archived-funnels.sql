-- =====================================================
-- ARCHIVED FUNNELS TABLE
-- Stores saved funnels from Front End Funnel with all steps
-- =====================================================

CREATE TABLE IF NOT EXISTS archived_funnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  total_steps INTEGER NOT NULL DEFAULT 0,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archived_funnels_created_at ON archived_funnels(created_at DESC);

ALTER TABLE archived_funnels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on archived_funnels" ON archived_funnels FOR ALL USING (true) WITH CHECK (true);
