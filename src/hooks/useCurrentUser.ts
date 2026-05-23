/**
 * Client-side hook: returns the current Supabase Auth user + their
 * `app_user_permissions` row. Re-runs on auth state changes.
 *
 * Returns:
 *   - `loading: true` while we're checking the initial session
 *   - `user: null` when no user is logged in
 *   - `user + permissions` when a user is logged in (permissions may
 *     have role='user' and sections=[] if their row hasn't been created
 *     yet by the trigger — the AuthGate handles that case by sending
 *     them to /no-access)
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import type { AppUserPermissions, AppRole } from '@/lib/auth/sections';

export interface CurrentUser {
  user: User;
  permissions: AppUserPermissions;
}

export function useCurrentUser() {
  const [data, setData] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPermissions = useCallback(async (user: User): Promise<AppUserPermissions> => {
    const fallback: AppUserPermissions = {
      user_id: user.id,
      role: 'user' as AppRole,
      sections: [] as string[],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const supabase = getSupabaseBrowser();
    if (!supabase) return fallback;
    try {
      const { data: row, error } = await supabase
        .from('app_user_permissions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) {
        console.warn('[useCurrentUser] permissions query error:', error.message);
        return fallback;
      }
      return (row as AppUserPermissions | null) ?? fallback;
    } catch (err) {
      console.warn('[useCurrentUser] permissions fetch threw:', err);
      return fallback;
    }
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) {
      // Env vars missing → nothing to gate, render as anon (the login
      // page would also fail, but at least the spinner doesn't hang).
      console.warn('[useCurrentUser] Supabase not configured — auth disabled');
      setLoading(false);
      return;
    }
    let cancelled = false;

    // Hard timeout: if for any reason the session/permissions calls hang
    // (flaky network, missing migration, etc.) we still flip loading=false
    // after 4s so the user sees either the page or the redirect to /login
    // instead of an eternal spinner. Better to fail open than to brick
    // the UI.
    const timeout = setTimeout(() => {
      if (cancelled) return;
      console.warn('[useCurrentUser] auth check timed out after 4s — releasing spinner');
      setLoading(false);
    }, 4000);

    (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        const user = session.session?.user ?? null;
        if (!user) {
          if (!cancelled) setData(null);
          return;
        }
        const permissions = await fetchPermissions(user);
        if (!cancelled) setData({ user, permissions });
      } catch (err) {
        console.warn('[useCurrentUser] initial auth check threw:', err);
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) {
          clearTimeout(timeout);
          setLoading(false);
        }
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (cancelled) return;
      const user = session?.user ?? null;
      if (!user) {
        setData(null);
        return;
      }
      try {
        const permissions = await fetchPermissions(user);
        if (!cancelled) setData({ user, permissions });
      } catch (err) {
        console.warn('[useCurrentUser] auth-change permissions refresh threw:', err);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      sub.subscription.unsubscribe();
    };
  }, [fetchPermissions]);

  return { ...(data ? data : { user: null, permissions: null }), loading };
}
