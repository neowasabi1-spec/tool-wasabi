-- UNBREAK the dashboard after app_user_permissions RLS froze every query.
-- LANGUAGE sql only. Safe to re-run.
--
-- 1) Turn OFF RLS on the permissions table (this is what made Template
--    hang — policies selected the same table they protected).
-- 2) Recreate is_master / get_master_id as a single PK lookup.
-- 3) Put Template / Clone / Projects back on every empty user row.

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
SET sections = ARRAY[
  'front-end-funnel', 'templates', 'products',
  'projects', 'checkpoint', 'protocollo-valchiria',
  'api-keys', 'api-usage'
]
WHERE role IS DISTINCT FROM 'master'
  AND (sections IS NULL OR cardinality(sections) = 0);

WITH first_row AS (
  SELECT user_id FROM public.app_user_permissions ORDER BY created_at ASC LIMIT 1
), has_master AS (
  SELECT EXISTS (SELECT 1 FROM public.app_user_permissions WHERE role = 'master') AS ok
)
UPDATE public.app_user_permissions p
SET
  role = 'master',
  sections = ARRAY[
    'front-end-funnel', 'quiz-swipe', 'templates', 'products',
    'projects', 'checkpoint', 'protocollo-valchiria',
    'api-keys', 'api-usage', 'admin-users', 'strategist'
  ]
FROM first_row, has_master
WHERE p.user_id = first_row.user_id
  AND has_master.ok = false;
