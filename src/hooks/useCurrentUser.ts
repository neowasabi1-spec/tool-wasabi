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
        // Read OUR own session blob (saved by LoginPageClient on login).
        // We don't trust the SDK's internal storage because it's been
        // flaky across navigations + lock contention.
        let stored: { access_token: string; refresh_token: string } | null = null;
        try {
          const raw = localStorage.getItem('wasabi_session');
          if (raw) stored = JSON.parse(raw);
        } catch { /* corrupt blob, treat as logged out */ }

        if (!stored?.access_token || !stored?.refresh_token) {
          console.info('[useCurrentUser] no wasabi_session in localStorage → unauthenticated');
          if (!cancelled) setData(null);
          return;
        }

        // Hydrate the SDK with our session so subsequent supabase calls
        // (e.g. supabase.from('app_user_permissions')...) include the
        // Authorization header.
        console.info('[useCurrentUser] step 1: setSession from stored blob…');
        const { data: setData_, error: setErr } = await supabase.auth.setSession({
          access_token: stored.access_token,
          refresh_token: stored.refresh_token,
        });
        if (setErr || !setData_.session) {
          console.warn('[useCurrentUser] setSession rejected:', setErr?.message || 'no session returned');
          // Stale / revoked session — purge and treat as logged out.
          try { localStorage.removeItem('wasabi_session'); } catch { /* ignore */ }
          if (!cancelled) setData(null);
          return;
        }
        console.info('[useCurrentUser] step 1 done, user=', setData_.session.user.id);

        // Refresh wasabi_session with the (possibly refreshed) tokens
        // returned by setSession so we don't get logged out next time
        // the access_token expires.
        try {
          localStorage.setItem('wasabi_session', JSON.stringify({
            access_token: setData_.session.access_token,
            refresh_token: setData_.session.refresh_token,
            user_id: setData_.session.user.id,
            email: setData_.session.user.email,
            expires_at: setData_.session.expires_at,
          }));
        } catch { /* ignore */ }

        console.info('[useCurrentUser] step 2: fetchPermissions');
        const permissions = await fetchPermissions(setData_.session.user);
        console.info(
          '[useCurrentUser] step 2 done',
          `role=${permissions.role} sections=${permissions.sections.length}`,
        );
        if (!cancelled) setData({ user: setData_.session.user, permissions });
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

    // Keep listening for tab-wide auth changes (logout from another tab,
    // token refresh, etc.) and mirror them into our wasabi_session blob.
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (cancelled) return;
      const user = session?.user ?? null;
      if (event === 'SIGNED_OUT' || !user) {
        try { localStorage.removeItem('wasabi_session'); } catch { /* ignore */ }
        setData(null);
        return;
      }
      if (session?.access_token && session?.refresh_token) {
        try {
          localStorage.setItem('wasabi_session', JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            user_id: user.id,
            email: user.email,
            expires_at: session.expires_at,
          }));
        } catch { /* ignore */ }
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
