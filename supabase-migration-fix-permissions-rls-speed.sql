-- Fix tool slowness after app_user_permissions was created.
--
-- Cause: RLS policies on app_user_permissions did
--   EXISTS (SELECT 1 FROM app_user_permissions WHERE …)
-- against THE SAME TABLE. Every page load then recursed through
-- is_master() on archived_funnels / swipe_templates / funnel_pages / …
--
-- This replaces those policies with public.is_master() (SECURITY DEFINER,
-- row_security off) so one PK lookup, no recursion.

CREATE OR REPLACE FUNCTION public.is_master(uid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
STABLE
AS $$
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.app_user_permissions
    WHERE user_id = uid AND role = 'master'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_master_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
STABLE
AS $$
DECLARE
  id UUID;
BEGIN
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT user_id INTO id
  FROM public.app_user_permissions
  WHERE role = 'master'
  ORDER BY created_at ASC
  LIMIT 1;
  RETURN id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_master(UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_master_id() TO authenticated, anon, service_role;

DO $$
BEGIN
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RAISE NOTICE 'app_user_permissions missing — nothing to re-policy.';
    RETURN;
  END IF;

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
END $$;
