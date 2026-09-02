-- Clone/Swipe pages created by Chimera (service role) were owned by the
-- master trigger, so regular users could not see their own project's steps.
-- Same helper as project_shares: owner / master / collaborator.

-- 1) Point existing project-linked pages at the project owner.
UPDATE public.funnel_pages fp
   SET owner_user_id = p.owner_user_id
  FROM public.projects p
 WHERE fp.project_id = p.id
   AND p.owner_user_id IS NOT NULL
   AND fp.owner_user_id IS DISTINCT FROM p.owner_user_id;

UPDATE public.page_html ph
   SET owner_user_id = fp.owner_user_id
  FROM public.funnel_pages fp
 WHERE ph.page_id = fp.id
   AND fp.owner_user_id IS NOT NULL
   AND ph.owner_user_id IS DISTINCT FROM fp.owner_user_id;

-- 2) RLS: project access, not only row owner.
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_select" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_insert" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_update" ON public.funnel_pages;
DROP POLICY IF EXISTS "funnel_pages_owner_or_master_delete" ON public.funnel_pages;

CREATE POLICY "funnel_pages_owner_or_master_select" ON public.funnel_pages FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, auth.uid()))
  );
CREATE POLICY "funnel_pages_owner_or_master_insert" ON public.funnel_pages FOR INSERT
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, auth.uid()))
  );
CREATE POLICY "funnel_pages_owner_or_master_update" ON public.funnel_pages FOR UPDATE
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, auth.uid()))
  )
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, auth.uid()))
  );
CREATE POLICY "funnel_pages_owner_or_master_delete" ON public.funnel_pages FOR DELETE
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR (project_id IS NOT NULL AND public.has_project_access(project_id, auth.uid()))
  );

DROP POLICY IF EXISTS "page_html_owner_or_master_select" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_insert" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_update" ON public.page_html;
DROP POLICY IF EXISTS "page_html_owner_or_master_delete" ON public.page_html;

CREATE POLICY "page_html_owner_or_master_select" ON public.page_html FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.funnel_pages fp
      WHERE fp.id = page_id
        AND fp.project_id IS NOT NULL
        AND public.has_project_access(fp.project_id, auth.uid())
    )
  );
CREATE POLICY "page_html_owner_or_master_insert" ON public.page_html FOR INSERT
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.funnel_pages fp
      WHERE fp.id = page_id
        AND fp.project_id IS NOT NULL
        AND public.has_project_access(fp.project_id, auth.uid())
    )
  );
CREATE POLICY "page_html_owner_or_master_update" ON public.page_html FOR UPDATE
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.funnel_pages fp
      WHERE fp.id = page_id
        AND fp.project_id IS NOT NULL
        AND public.has_project_access(fp.project_id, auth.uid())
    )
  )
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.funnel_pages fp
      WHERE fp.id = page_id
        AND fp.project_id IS NOT NULL
        AND public.has_project_access(fp.project_id, auth.uid())
    )
  );
CREATE POLICY "page_html_owner_or_master_delete" ON public.page_html FOR DELETE
  USING (
    owner_user_id = auth.uid()
    OR public.is_master(auth.uid())
    OR auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM public.funnel_pages fp
      WHERE fp.id = page_id
        AND fp.project_id IS NOT NULL
        AND public.has_project_access(fp.project_id, auth.uid())
    )
  );
