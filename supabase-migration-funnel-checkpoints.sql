-- Migration: funnel_checkpoints
--
-- Stores per-funnel quality audit runs ("Checkpoint"). One row per RUN
-- (not per funnel) so we keep history and can show trends over time.
-- The same funnel can be checkpointed many times — each click on
-- "Run Checkpoint" creates a new row.
--
-- Source funnels live in 3 different tables (funnel_pages,
-- post_purchase_pages, archived_funnels). We don't FK to any of them
-- because the same funnel could be re-imported under a different ID
-- and we'd lose history. Instead we store source_table + source_id as
-- a soft pointer.

CREATE TABLE IF NOT EXISTS funnel_checkpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Soft pointer to the source funnel row.
  -- source_table: 'funnel_pages' | 'post_purchase_pages' | 'archived_funnels'
  source_table TEXT NOT NULL,
  source_id    TEXT NOT NULL,

  -- Snapshot of the funnel name + URL at the moment of the run, so the
  -- history stays meaningful even if the source row is renamed/deleted.
  funnel_name TEXT NOT NULL DEFAULT '',
  funnel_url  TEXT NOT NULL DEFAULT '',

  -- Was the funnel "swiped" (rewritten by Claude) at run time? Useful
  -- to filter the dashboard ("show only checkpoints on swiped funnels").
  was_swiped BOOLEAN NOT NULL DEFAULT FALSE,

  -- Per-category score 0-100, NULL when the category wasn't run.
  score_cro        INTEGER,
  score_coherence  INTEGER,
  score_tov        INTEGER,
  score_compliance INTEGER,
  score_copy       INTEGER,

  -- Aggregate score (avg of non-null categories), denormalized for
  -- cheap list rendering.
  score_overall INTEGER,

  -- Full structured result per category (issues, suggestions, raw
  -- AI reply, prompt token usage, etc.). Each category is an object
  -- shaped { score, status, summary, issues[], suggestions[], usage }.
  results JSONB NOT NULL DEFAULT '{}',

  -- Lifecycle.
  -- status: 'running' | 'completed' | 'partial' | 'failed'
  status     TEXT NOT NULL DEFAULT 'running',
  error      TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Optional: project this funnel belongs to (mirrors projects.id) so
  -- we can filter checkpoints by project.
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_source
  ON funnel_checkpoints(source_table, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_project
  ON funnel_checkpoints(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_status
  ON funnel_checkpoints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_checkpoints_score
  ON funnel_checkpoints(score_overall DESC NULLS LAST);
