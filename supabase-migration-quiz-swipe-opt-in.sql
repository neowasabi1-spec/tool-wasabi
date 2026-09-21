-- Clone / Swipe Quiz is opt-in.
--
-- If `app_user_permissions` was never created, this is a no-op (there
-- is nothing to strip). Regular users already cannot see Clone Quiz
-- until you run supabase-migration-user-permissions.sql and enable the
-- section in Settings → Users.
--
-- If the table exists, remove quiz-swipe from every non-master so only
-- people you re-enable in Users will see it.

DO $$
BEGIN
  IF to_regclass('public.app_user_permissions') IS NULL THEN
    RAISE NOTICE 'app_user_permissions does not exist — nothing to update. Run supabase-migration-user-permissions.sql if you want per-user section toggles.';
    RETURN;
  END IF;

  UPDATE public.app_user_permissions
  SET sections = array_remove(sections, 'quiz-swipe')
  WHERE role IS DISTINCT FROM 'master'
    AND sections IS NOT NULL
    AND 'quiz-swipe' = ANY (sections);
END $$;
