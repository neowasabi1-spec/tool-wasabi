-- Clone / Swipe Quiz is opt-in: hide it from regular users.
-- Masters still see it (role = master bypasses the sections list).
-- Re-enable per user from Settings → Users by checking "Clone / Swipe Quiz".

UPDATE public.app_user_permissions
SET sections = array_remove(sections, 'quiz-swipe')
WHERE role IS DISTINCT FROM 'master'
  AND sections IS NOT NULL
  AND 'quiz-swipe' = ANY (sections);
