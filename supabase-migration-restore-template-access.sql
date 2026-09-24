-- Restore Template access. Does NOT touch archived_funnels / other
-- library tables — only app_user_permissions.
--
-- After user-permissions was created, only the oldest login was master
-- and everyone else had empty sections, so Template disappeared.
--
-- Safe to re-run.

DO $$
DECLARE
  master_id UUID;
BEGIN
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RAISE NOTICE 'app_user_permissions missing — run supabase-migration-user-permissions.sql first.';
    RETURN;
  END IF;

  SELECT user_id INTO master_id
  FROM public.app_user_permissions
  WHERE role = 'master'
  ORDER BY created_at ASC
  LIMIT 1;

  IF master_id IS NULL THEN
    SELECT user_id INTO master_id
    FROM public.app_user_permissions
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF master_id IS NULL THEN
    INSERT INTO public.app_user_permissions (user_id, role, sections)
    SELECT u.id, 'master', ARRAY[
      'front-end-funnel', 'quiz-swipe', 'templates', 'products',
      'projects', 'checkpoint', 'protocollo-valchiria',
      'api-keys', 'api-usage', 'admin-users', 'strategist'
    ]
    FROM auth.users u
    ORDER BY u.created_at ASC
    LIMIT 1
    ON CONFLICT (user_id) DO UPDATE
      SET role = 'master',
          sections = EXCLUDED.sections;
    RETURN;
  END IF;

  UPDATE public.app_user_permissions
  SET
    role = 'master',
    sections = ARRAY[
      'front-end-funnel', 'quiz-swipe', 'templates', 'products',
      'projects', 'checkpoint', 'protocollo-valchiria',
      'api-keys', 'api-usage', 'admin-users', 'strategist'
    ]
  WHERE user_id = master_id;

  UPDATE public.app_user_permissions
  SET sections = ARRAY[
    'front-end-funnel', 'templates', 'products',
    'projects', 'checkpoint', 'protocollo-valchiria',
    'api-keys', 'api-usage'
  ]
  WHERE role IS DISTINCT FROM 'master'
    AND (sections IS NULL OR cardinality(sections) = 0);
END $$;
