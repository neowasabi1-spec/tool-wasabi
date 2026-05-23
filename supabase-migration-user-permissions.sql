-- =====================================================================
-- APP USER PERMISSIONS — multi-user access control for the dashboard
-- =====================================================================
-- Adds a single table that maps Supabase Auth users (auth.users) to a
-- role + a list of dashboard sections they're allowed to see.
--
-- Sections are the sidebar entries, by stable id:
--   front-end-funnel, quiz-swipe, templates, products, projects,
--   checkpoint, protocollo-valchiria, api-keys, api-usage, admin-users
--
-- The MASTER role is granted ALL sections automatically (the admin UI
-- doesn't bother showing the toggles for masters).
--
-- Bootstrap: the first user to log in becomes the master. See the
-- handle_new_user() trigger below.
-- =====================================================================

-- 1) Table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user_permissions (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('master', 'user')),
  sections    TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_user_permissions_role
  ON app_user_permissions(role);

-- 2) updated_at trigger ----------------------------------------------
CREATE OR REPLACE FUNCTION app_user_permissions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_user_permissions_updated_at ON app_user_permissions;
CREATE TRIGGER trg_app_user_permissions_updated_at
  BEFORE UPDATE ON app_user_permissions
  FOR EACH ROW
  EXECUTE FUNCTION app_user_permissions_touch_updated_at();

-- 3) RLS -------------------------------------------------------------
-- Users can read their OWN permissions (needed by the client-side
-- sidebar / page guards). Masters can read/write everyone's. Writes
-- from anyone else are blocked.
ALTER TABLE app_user_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own permissions" ON app_user_permissions;
CREATE POLICY "users read own permissions"
  ON app_user_permissions
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "masters read all permissions" ON app_user_permissions;
CREATE POLICY "masters read all permissions"
  ON app_user_permissions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM app_user_permissions p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
  );

DROP POLICY IF EXISTS "masters write all permissions" ON app_user_permissions;
CREATE POLICY "masters write all permissions"
  ON app_user_permissions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM app_user_permissions p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_user_permissions p
      WHERE p.user_id = auth.uid() AND p.role = 'master'
    )
  );

-- 4) Auto-promote the very first user to master ----------------------
-- Runs after INSERT on auth.users. If no master exists yet, the new
-- user is created as a master with all sections. Otherwise they're
-- created as a regular user with NO sections (the master then assigns
-- them via the /admin/users UI).
CREATE OR REPLACE FUNCTION app_handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  master_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO master_count
  FROM app_user_permissions
  WHERE role = 'master';

  IF master_count = 0 THEN
    INSERT INTO app_user_permissions (user_id, role, sections)
    VALUES (
      NEW.id,
      'master',
      ARRAY[
        'front-end-funnel', 'quiz-swipe', 'templates', 'products',
        'projects', 'checkpoint', 'protocollo-valchiria',
        'api-keys', 'api-usage', 'admin-users'
      ]
    )
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    INSERT INTO app_user_permissions (user_id, role, sections)
    VALUES (NEW.id, 'user', ARRAY[]::TEXT[])
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_app_handle_new_user ON auth.users;
CREATE TRIGGER trg_app_handle_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION app_handle_new_user();

-- 5) Backfill: every EXISTING auth.users row that has no permissions
--    row gets one. The FIRST one (by created_at ASC) becomes the
--    master if no master exists yet. Idempotent — safe to re-run.
DO $$
DECLARE
  has_master BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM app_user_permissions WHERE role = 'master')
  INTO has_master;

  IF NOT has_master THEN
    INSERT INTO app_user_permissions (user_id, role, sections)
    SELECT
      u.id,
      'master',
      ARRAY[
        'front-end-funnel', 'quiz-swipe', 'templates', 'products',
        'projects', 'checkpoint', 'protocollo-valchiria',
        'api-keys', 'api-usage', 'admin-users'
      ]
    FROM auth.users u
    WHERE NOT EXISTS (
      SELECT 1 FROM app_user_permissions p WHERE p.user_id = u.id
    )
    ORDER BY u.created_at ASC
    LIMIT 1
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- Everyone else without a permissions row → plain user with 0 sections.
  INSERT INTO app_user_permissions (user_id, role, sections)
  SELECT u.id, 'user', ARRAY[]::TEXT[]
  FROM auth.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM app_user_permissions p WHERE p.user_id = u.id
  )
  ON CONFLICT (user_id) DO NOTHING;
END $$;

-- =====================================================================
-- DONE. Run this once on the Supabase SQL editor. After running, the
-- next person to log in (or the existing first user, by created_at)
-- is automatically the master.
-- =====================================================================
