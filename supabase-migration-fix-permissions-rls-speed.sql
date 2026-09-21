-- Fix tool slowness after app_user_permissions was created.
-- LANGUAGE sql (not plpgsql) so it runs on every Supabase project.

CREATE OR REPLACE FUNCTION public.is_master(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
SET row_security = off
STABLE
AS $$
  SELECT COALESCE(uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.app_user_permissions
    WHERE user_id = uid AND role = 'master'
  ), false);
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

DROP POLICY IF EXISTS "users read own permissions" ON public.app_user_permissions;
DROP POLICY IF EXISTS "masters read all permissions" ON public.app_user_permissions;
DROP POLICY IF EXISTS "masters write all permissions" ON public.app_user_permissions;

CREATE POLICY "users read own permissions"
  ON public.app_user_permissions
  FOR SELECT
  USING (user_id = auth.uid() OR public.is_master(auth.uid()));

CREATE POLICY "masters write all permissions"
  ON public.app_user_permissions
  FOR ALL
  USING (public.is_master(auth.uid()))
  WITH CHECK (public.is_master(auth.uid()));
