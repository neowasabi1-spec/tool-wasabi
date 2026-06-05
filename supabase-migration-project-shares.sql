-- =====================================================================
-- PROJECT SHARES — collaborative access on a per-user basis
-- =====================================================================
-- Lets the master pick specific users that should see / edit a given
-- project (and its child rows: project_files, funnel_steps). Behaves
-- like an ACL: a row in project_shares grants the listed user the same
-- read+write access as the owner for that specific project.
--
-- Design:
--   * A new junction table public.project_shares(project_id, user_id).
--   * A helper public.has_project_access(project_id, user_id) used by
--     every RLS policy that needs the "owner OR master OR share OR
--     unauth-server-call" decision in a single SQL expression. This
--     avoids drift between policies and keeps them readable.
--   * Updated policies on projects + project_files + funnel_steps to
--     read access from the helper. DELETE on projects stays restricted
--     to owner/master so a collaborator can't nuke the master's project.
--
-- Visibility: a shared user sees the project as if they owned it —
-- it appears in their /projects list automatically, they can read/write
-- brief/files/funnel_steps, but they cannot DELETE the project itself
-- and they cannot manage who else is shared on it.
--
-- IDEMPOTENT: re-running is safe.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1) project_shares table
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_shares (
  project_id  UUID        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  shared_by   UUID            NULL REFERENCES auth.users(id)      ON DELETE SET NULL,
  shared_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_shares_user_idx    ON public.project_shares(user_id);
CREATE INDEX IF NOT EXISTS project_shares_project_idx ON public.project_shares(project_id);

ALTER TABLE public.project_shares ENABLE ROW LEVEL SECURITY;

-- Anyone who has the role of master or who is one of the linked users
-- can SELECT the rows. Mutations are master-only (the share modal lives
-- on the master's My-Projects page). The OR auth.uid() IS NULL clause
-- keeps server-to-server / cron callers working — same pattern used
-- by the rest of the multi-tenancy phase 1 policies.
DROP POLICY IF EXISTS "project_shares_select" ON public.project_shares;
DROP POLICY IF EXISTS "project_shares_insert" ON public.project_shares;
DROP POLICY IF EXISTS "project_shares_delete" ON public.project_shares;

CREATE POLICY "project_shares_select" ON public.project_shares FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
  );
CREATE POLICY "project_shares_insert" ON public.project_shares FOR INSERT
  WITH CHECK (
    public.is_master(auth.uid())
    OR auth.uid() IS NULL
  );
CREATE POLICY "project_shares_delete" ON public.project_shares FOR DELETE
  USING (
    public.is_master(auth.uid())
    OR auth.uid() IS NULL
  );

-- ─────────────────────────────────────────────────────────────────────
-- 2) has_project_access(project_id, user_id) — used by every policy
-- ─────────────────────────────────────────────────────────────────────
-- Returns TRUE when `u_id` should be allowed to read/write rows tied
-- to project `p_id`. Cases:
--   (a) u_id IS NULL          → legacy server-to-server call (phase 1
--                                 fallback, removed in phase 2)
--   (b) is_master(u_id)       → master sees everything
--   (c) the project belongs to u_id (owner)
--   (d) the project has a project_shares row for u_id (collaborator)
--
-- SECURITY DEFINER so it bypasses RLS while checking — otherwise the
-- check would loop through the very policies that call it.
CREATE OR REPLACE FUNCTION public.has_project_access(p_id UUID, u_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    u_id IS NULL
    OR public.is_master(u_id)
    OR EXISTS (
      SELECT 1 FROM public.projects
       WHERE id = p_id AND owner_user_id = u_id
    )
    OR EXISTS (
      SELECT 1 FROM public.project_shares
       WHERE project_id = p_id AND user_id = u_id
    );
$$;

GRANT EXECUTE ON FUNCTION public.has_project_access(UUID, UUID)
  TO authenticated, anon, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 3) Extend RLS on projects / project_files / funnel_steps
-- ─────────────────────────────────────────────────────────────────────
-- We REPLACE the SELECT/UPDATE policies installed by the multi-tenancy
-- phase 1 migration with versions that delegate to has_project_access,
-- so a collaborator sees the project in their list and can edit it.
--
-- DELETE on `projects` stays owner/master-only — a shared collaborator
-- must not be able to delete the master's project. INSERT keeps the
-- old "the inserter owns the row" rule via owner_user_id check.
--
-- For child tables we use the project_id column to delegate to
-- has_project_access — that way the collaborator can read AND modify
-- rows the owner originally created (the trigger sets owner_user_id
-- to the collaborator's UUID on new rows, so they own their additions
-- as expected).

-- 3a) projects -----------------------------------------------------
DROP POLICY IF EXISTS "projects_owner_or_master_select" ON public.projects;
DROP POLICY IF EXISTS "projects_owner_or_master_update" ON public.projects;
-- INSERT + DELETE policies installed by the phase 1 migration stay
-- untouched (insert: only as yourself; delete: only owner/master).

CREATE POLICY "projects_owner_or_master_select" ON public.projects FOR SELECT
  USING (public.has_project_access(id, auth.uid()));
CREATE POLICY "projects_owner_or_master_update" ON public.projects FOR UPDATE
  USING (public.has_project_access(id, auth.uid()))
  WITH CHECK (public.has_project_access(id, auth.uid()));

-- 3b) project_files ----------------------------------------------
DROP POLICY IF EXISTS "project_files_owner_or_master_select" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_insert" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_update" ON public.project_files;
DROP POLICY IF EXISTS "project_files_owner_or_master_delete" ON public.project_files;

CREATE POLICY "project_files_owner_or_master_select" ON public.project_files FOR SELECT
  USING (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "project_files_owner_or_master_insert" ON public.project_files FOR INSERT
  WITH CHECK (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "project_files_owner_or_master_update" ON public.project_files FOR UPDATE
  USING (public.has_project_access(project_id, auth.uid()))
  WITH CHECK (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "project_files_owner_or_master_delete" ON public.project_files FOR DELETE
  USING (public.has_project_access(project_id, auth.uid()));

-- 3c) funnel_steps -----------------------------------------------
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_select" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_insert" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_update" ON public.funnel_steps;
DROP POLICY IF EXISTS "funnel_steps_owner_or_master_delete" ON public.funnel_steps;

CREATE POLICY "funnel_steps_owner_or_master_select" ON public.funnel_steps FOR SELECT
  USING (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "funnel_steps_owner_or_master_insert" ON public.funnel_steps FOR INSERT
  WITH CHECK (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "funnel_steps_owner_or_master_update" ON public.funnel_steps FOR UPDATE
  USING (public.has_project_access(project_id, auth.uid()))
  WITH CHECK (public.has_project_access(project_id, auth.uid()));
CREATE POLICY "funnel_steps_owner_or_master_delete" ON public.funnel_steps FOR DELETE
  USING (public.has_project_access(project_id, auth.uid()));

-- 3d) funnel_flows (groupings of funnel_steps under a project) -----
-- Same story — we want the collaborator to see/edit the flow header
-- (e.g. rename the flow). Skip if the table doesn't exist yet on
-- older installs.
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "funnel_flows_owner_or_master_select" ON public.funnel_flows';
  EXECUTE 'DROP POLICY IF EXISTS "funnel_flows_owner_or_master_insert" ON public.funnel_flows';
  EXECUTE 'DROP POLICY IF EXISTS "funnel_flows_owner_or_master_update" ON public.funnel_flows';
  EXECUTE 'DROP POLICY IF EXISTS "funnel_flows_owner_or_master_delete" ON public.funnel_flows';
  EXECUTE 'CREATE POLICY "funnel_flows_owner_or_master_select" ON public.funnel_flows FOR SELECT USING (public.has_project_access(project_id, auth.uid()))';
  EXECUTE 'CREATE POLICY "funnel_flows_owner_or_master_insert" ON public.funnel_flows FOR INSERT WITH CHECK (public.has_project_access(project_id, auth.uid()))';
  EXECUTE 'CREATE POLICY "funnel_flows_owner_or_master_update" ON public.funnel_flows FOR UPDATE USING (public.has_project_access(project_id, auth.uid())) WITH CHECK (public.has_project_access(project_id, auth.uid()))';
  EXECUTE 'CREATE POLICY "funnel_flows_owner_or_master_delete" ON public.funnel_flows FOR DELETE USING (public.has_project_access(project_id, auth.uid()))';
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

COMMIT;

-- =====================================================================
-- DONE — Project sharing applied.
--
-- After running:
--   * project_shares table is live with RLS.
--   * has_project_access(project_id, user_id) returns true for
--     owner / master / shared collaborators (and for unauth server
--     callers during phase 1).
--   * projects / project_files / funnel_steps / funnel_flows policies
--     now use the helper for SELECT + UPDATE (and INSERT/DELETE on
--     children). Collaborators see shared projects in their list and
--     can fully edit them.
--   * DELETE on projects stays owner/master-only (collaborator can't
--     delete the project itself).
--
-- ROLLBACK (manual):
--   DROP TABLE public.project_shares CASCADE;
--   -- then re-run supabase-migration-multi-tenancy.sql to restore the
--   -- owner-only policies on projects/project_files/funnel_steps.
-- =====================================================================
