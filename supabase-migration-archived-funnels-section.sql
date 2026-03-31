-- =====================================================
-- ADD section COLUMN TO archived_funnels
-- Allows distinguishing quiz funnels from regular funnels
-- Values: 'funnel' (default), 'quiz'
-- =====================================================

ALTER TABLE archived_funnels
  ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'funnel';

CREATE INDEX IF NOT EXISTS idx_archived_funnels_section ON archived_funnels(section);
