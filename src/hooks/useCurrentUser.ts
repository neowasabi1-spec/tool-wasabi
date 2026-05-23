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
import type { AppUserPermissions, AppRole } from '@/lib/auth/sections';

export interface CurrentUser {
  user: User;
  permissions: AppUserPermissions;
}

interface StoredSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email?: string;
  expires_at?: number;
}

function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.access_token || !parsed?.user_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Direct REST call to Supabase — bypasses the JS SDK entirely (which
 *  has been hanging on session locks / setSession verification) so we
 *  ALWAYS finish in a bounded time. Returns the parsed app_user_permissions
 *  row or null on miss / error. The caller falls back to a synthetic
 *  zero-permission row in that case. */
async function fetchPermissionsViaRest(
  userId: string,
  accessToken: string,
  timeoutMs: number,
): Promise<AppUserPermissions | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/app_user_permissions?user_id=eq.${encodeURIComponent(userId)}&select=*`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[useCurrentUser] permissions REST ${res.status}`);
      return null;
    }
    const rows = (await res.json()) as AppUserPermissions[];
    return rows?.[0] ?? null;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      console.warn('[useCurrentUser] permissions REST aborted (timeout)');
    } else {
      console.warn('[useCurrentUser] permissions REST threw:', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useCurrentUser() {
  const [data, setData] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPermissions = useCallback(async (user: User, accessToken: string): Promise<AppUserPermissions> => {
    const fallback: AppUserPermissions = {
      user_id: user.id,
      role: 'user' as AppRole,
      sections: [] as string[],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const row = await fetchPermissionsViaRest(user.id, accessToken, 2500);
    return row ?? fallback;
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Hard timeout: if for any reason the permissions REST call hangs
    // we still flip loading=false after 4s so the AuthGate can decide
    // whether to render the page or redirect to /login. Failing open
    // (= treating timeouts as "no session") sends the user back to
    // login, which is the safest option.
    const timeout = setTimeout(() => {
      if (cancelled) return;
      console.warn('[useCurrentUser] auth check timed out after 4s — releasing spinner');
      setLoading(false);
    }, 4000);

    (async () => {
      try {
        const stored = readStoredSession();
        if (!stored) {
          console.info('[useCurrentUser] no wasabi_session → unauthenticated');
          if (!cancelled) setData(null);
          return;
        }

        // Build a minimal synthetic `User` so the rest of the app keeps
        // working without touching the SDK. We avoid `supabase.auth.setSession`
        // entirely because it does a /user verification network call that
        // has been hanging on stale lock contention.
        const user = {
          id: stored.user_id,
          email: stored.email,
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: '',
        } as unknown as User;

        console.info('[useCurrentUser] step 1: fetchPermissions via REST');
        const permissions = await fetchPermissions(user, stored.access_token);
        console.info(
          '[useCurrentUser] step 1 done',
          `role=${permissions.role} sections=${permissions.sections.length}`,
        );
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

    // Cross-tab sync: react to localStorage changes (sign-out in another
    // tab clears `wasabi_session`).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'wasabi_session') return;
      if (!e.newValue) {
        setData(null);
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      window.removeEventListener('storage', onStorage);
    };
  }, [fetchPermissions]);

  return { ...(data ? data : { user: null, permissions: null }), loading };
}
