-- Put Users/master back how they were before the quiz SQL.
-- Run on the SAME project as the app (templates_table must not be NULL).

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

UPDATE public.app_user_permissions
SET
  role = 'master',
  sections = ARRAY[
    'front-end-funnel', 'quiz-swipe', 'templates', 'products',
    'projects', 'checkpoint', 'protocollo-valchiria',
    'api-keys', 'api-usage', 'admin-users', 'strategist'
  ];
