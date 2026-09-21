-- Unbreak Template. Run on the SAME Supabase project the app uses.
-- First result row: if templates_table is NULL you are in the wrong project.
-- LANGUAGE sql only. Safe to re-run.

SELECT
  current_database() AS db,
  to_regclass('public.app_user_permissions') AS permissions_table,
  to_regclass('public.archived_funnels') AS templates_table;

ALTER TABLE public.app_user_permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_user_permissions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own permissions" ON public.app_user_permissions;
DROP POLICY IF EXISTS "masters read all permissions" ON public.app_user_permissions;
DROP POLICY IF EXISTS "masters write all permissions" ON public.app_user_permissions;

CREATE OR REPLACE FUNCTION public.is_master(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
SET row_security = off
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_user_permissions
    WHERE user_id = uid AND role = 'master'
  );
$$;

CREATE OR REPLACE FUNCTION public.get_master_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
SET row_security = off
STABLE
AS $$
  SELECT user_id FROM public.app_user_permissions
  WHERE role = 'master'
  ORDER BY created_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.is_master(UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_master_id() TO authenticated, anon, service_role;

-- Add library sections back. Does not wipe quiz / admin toggles already set.
UPDATE public.app_user_permissions
SET sections = (
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(
      COALESCE(sections, ARRAY[]::text[]) || ARRAY[
        'front-end-funnel', 'templates', 'products',
        'projects', 'checkpoint', 'protocollo-valchiria',
        'api-keys', 'api-usage'
      ]
    ) AS x
  )
);

WITH first_row AS (
  SELECT user_id FROM public.app_user_permissions ORDER BY created_at ASC LIMIT 1
), has_master AS (
  SELECT EXISTS (SELECT 1 FROM public.app_user_permissions WHERE role = 'master') AS ok
)
UPDATE public.app_user_permissions p
SET role = 'master'
FROM first_row, has_master
WHERE p.user_id = first_row.user_id
  AND has_master.ok = false;
