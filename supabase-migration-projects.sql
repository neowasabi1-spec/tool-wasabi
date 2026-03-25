-- Migration: Create projects table
-- If table already exists: DROP TABLE IF EXISTS projects; then re-run this.
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  domain TEXT NOT NULL DEFAULT '',

  -- Assets
  logo JSONB NOT NULL DEFAULT '[]',

  -- Sections (JSONB for flexibility)
  market_research JSONB NOT NULL DEFAULT '{}',
  brief TEXT NOT NULL DEFAULT '',
  front_end JSONB NOT NULL DEFAULT '{}',
  back_end JSONB NOT NULL DEFAULT '{}',
  compliance_funnel JSONB NOT NULL DEFAULT '{}',
  funnel JSONB NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);

CREATE OR REPLACE FUNCTION update_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_projects_updated_at ON projects;
CREATE TRIGGER trigger_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_projects_updated_at();
