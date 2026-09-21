-- Restore Template / archive access after app_user_permissions was created
-- on a database that already had users.
--
-- What went wrong: only the OLDEST auth.users row became master; everyone
-- else got role=user and sections={}. The UI then hid Template and the
-- library looked empty.
--
-- This:
--   1) Makes the account that owns most archived pages a master
--      (fallback: the current master, or the oldest user).
--   2) Gives every other existing user the library sections back
--      (Clone/Swipe, Template, Projects, …) — NOT Clone / Swipe Quiz.

DO $$
DECLARE
  master_id UUID;
BEGIN
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RAISE NOTICE 'app_user_permissions missing — run supabase-migration-user-permissions.sql first.';
    RETURN;
  END IF;

  SELECT owner_user_id INTO master_id
  FROM public.archived_funnels
  WHERE owner_user_id IS NOT NULL
  GROUP BY owner_user_id
  ORDER BY COUNT(*) DESC
  LIMIT 1;

  IF master_id IS NULL THEN
    SELECT user_id INTO master_id
    FROM public.app_user_permissions
    WHERE role = 'master'
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF master_id IS NULL THEN
    SELECT user_id INTO master_id
    FROM public.app_user_permissions
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF master_id IS NOT NULL THEN
    UPDATE public.app_user_permissions
    SET
      role = 'master',
      sections = ARRAY[
        'front-end-funnel', 'quiz-swipe', 'templates', 'products',
        'projects', 'checkpoint', 'protocollo-valchiria',
        'api-keys', 'api-usage', 'admin-users', 'strategist'
      ]
    WHERE user_id = master_id;
  END IF;

  UPDATE public.app_user_permissions
  SET sections = ARRAY[
    'front-end-funnel', 'templates', 'products',
    'projects', 'checkpoint', 'protocollo-valchiria',
    'api-keys', 'api-usage'
  ]
  WHERE role IS DISTINCT FROM 'master'
    AND (sections IS NULL OR cardinality(sections) = 0);
END $$;
