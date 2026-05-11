-- Migration: checkpoint_funnels + funnel_checkpoints
--
-- Two-table design:
--
--   checkpoint_funnels   = the user's library of funnels-to-audit
--                          (manually added by the user, one row each).
--   funnel_checkpoints   = run history (one row per "Run Checkpoint"
--                          click; many runs per funnel).
--
-- We deliberately do NOT auto-pull from funnel_pages /
-- post_purchase_pages / archived_funnels — the Checkpoint section is
-- a self-contained surface where the user decides which URLs to
-- monitor for CRO/coherence/tone of voice/compliance/copy quality.

CREATE TABLE IF NOT EXISTS checkpoint_funnels (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  notes       TEXT,
  -- Optional: brand voice profile used by the Tone of Voice category.
  brand_profile TEXT,
  -- Optional: 'supplement' | 'digital' | 'both' — drives compliance routing.
  product_type TEXT NOT NULL DEFAULT 'both',
  -- Optional: project this funnel belongs to.
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- Denormalised "last run" snapshot for cheap list rendering.
  last_run_id        UUID,
  last_score_overall INTEGER,
  last_run_status    TEXT,
  last_run_at        TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_funnels_updated
  ON checkpoint_funnels(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoint_funnels_project
  ON checkpoint_funnels(project_id, updated_at DESC);

CREATE OR REPLACE FUNCTION update_checkpoint_funnels_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_checkpoint_funnels_updated_at ON checkpoint_funnels;
CREATE TRIGGER trigger_checkpoint_funnels_updated_at
  BEFORE UPDATE ON checkpoint_funnels
  FOR EACH ROW
  EXECUTE FUNCTION update_checkpoint_funnels_updated_at();

-- Run history: one row per "Run Checkpoint" click. Many per funnel.
CREATE TABLE IF NOT EXISTS funnel_checkpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- FK back to the user-added funnel. Cascade so deleting a funnel
  -- nukes its history.
  checkpoint_funnel_id UUID NOT NULL
    REFERENCES checkpoint_funnels(id) ON DELETE CASCADE,

  -- Snapshot of the funnel name + URL at run time so the history
  -- stays meaningful even if the source row is renamed later.
  funnel_name TEXT NOT NULL DEFAULT '',
  funnel_url  TEXT NOT NULL DEFAULT '',

  -- Per-category score 0-100, NULL when the category wasn't run.
  score_cro        INTEGER,
  score_coherence  INTEGER,
  score_tov        INTEGER,
  score_compliance INTEGER,
  score_copy       INTEGER,

  -- Aggregate (avg of non-null categories).
  score_overall INTEGER,

  -- Full structured payload per category.
  results JSONB NOT NULL DEFAULT '{}',

  -- Lifecycle: 'running' | 'completed' | 'partial' | 'failed'.
  status     TEXT NOT NULL DEFAULT 'running',
  error      TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Audit log: who pressed "Run Checkpoint".
  -- triggered_by_user_id is left FK-less for now because the users
  -- table doesn't exist yet — when it lands, add:
  --   ALTER TABLE funnel_checkpoints
  --   ADD CONSTRAINT funnel_checkpoints_triggered_by_user_id_fkey
  --   FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  -- We always also store the name as a snapshot so the log stays
  -- readable even if the user is later renamed/deleted.
  triggered_by_user_id UUID,
  triggered_by_name    TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent: also add the audit columns when the table already
-- exists from an earlier run of this migration.
ALTER TABLE funnel_checkpoints
  ADD COLUMN IF NOT EXISTS triggered_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS triggered_by_name    TEXT;

CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_funnel
  ON funnel_checkpoints(checkpoint_funnel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_status
  ON funnel_checkpoints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_score
  ON funnel_checkpoints(score_overall DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_triggered_by
  ON funnel_checkpoints(triggered_by_user_id, created_at DESC);
-- Global "log" view: newest first, all funnels.
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_created
  ON funnel_checkpoints(created_at DESC);
