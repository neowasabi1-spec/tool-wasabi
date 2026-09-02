-- Templates is a team library: every logged-in user can READ the same
-- archived_funnels rows that are NOT tied to a project (project_id IS NULL).
-- Competitor landings (project_id set) stay private to that project.
--
-- This replaces the old "share_with_users + master only" SELECT gate.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS "archived_funnels_shared_library_select" ON public.archived_funnels;
DROP POLICY IF EXISTS "archived_funnels_templates_library_select" ON public.archived_funnels;

CREATE POLICY "archived_funnels_templates_library_select"
  ON public.archived_funnels
  FOR SELECT
  TO authenticated
  USING (project_id IS NULL);

COMMIT;
