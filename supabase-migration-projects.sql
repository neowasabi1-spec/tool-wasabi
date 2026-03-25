-- Migration: Create projects table with all sections
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,

  -- Project sections (stored as JSONB for flexibility)
  logo JSONB NOT NULL DEFAULT '[]',
  mockup JSONB NOT NULL DEFAULT '[]',
  label JSONB NOT NULL DEFAULT '[]',
  market_research JSONB NOT NULL DEFAULT '{}',
  selected_products JSONB NOT NULL DEFAULT '[]',
  flow_steps JSONB NOT NULL DEFAULT '[[],[],[],[],[],[]]',
  brief TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);

-- Auto-update updated_at on row change
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
