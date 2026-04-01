-- =====================================================
-- ADD project_id TO funnel_pages, swipe_templates, archived_funnels
-- Links these entities to a project for project-level views
-- Safe to run multiple times (IF NOT EXISTS)
-- =====================================================

-- funnel_pages
ALTER TABLE funnel_pages ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_funnel_pages_project_id ON funnel_pages(project_id);

-- swipe_templates
ALTER TABLE swipe_templates ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_swipe_templates_project_id ON swipe_templates(project_id);

-- archived_funnels
ALTER TABLE archived_funnels ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_archived_funnels_project_id ON archived_funnels(project_id);
