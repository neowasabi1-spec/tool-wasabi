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
import { authFetch } from '@/lib/auth/client-fetch';

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

/** Server-side "who am I" call. Goes through our own /api/auth/whoami
 *  endpoint which uses the service-role admin client under the hood,
 *  so any RLS misconfiguration on app_user_permissions can NOT silently
 *  demote the user to role='user'/sections=[]. Returns the true row, or
 *  null if the call fails / times out.
 *
 *  Usa `authFetch` (non un fetch grezzo) cosi' se l'access_token e' scaduto
 *  la 401 di whoami innesca il refresh automatico col refresh_token e la
 *  richiesta viene riprovata col token nuovo. Senza questo, dopo la scadenza
 *  del token (~30-60 min) whoami tornava 401 → permessi vuoti → /no-access,
 *  buttando fuori l'utente periodicamente. */
async function fetchWhoamiViaServer(
  timeoutMs: number,
): Promise<{ user: { id: string; email: string | null }; permissions: AppUserPermissions } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await authFetch('/api/auth/whoami', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[useCurrentUser] whoami HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as {
      user: { id: string; email: string | null };
      permissions: AppUserPermissions;
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      console.warn('[useCurrentUser] whoami aborted (timeout)');
    } else {
      console.warn('[useCurrentUser] whoami threw:', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    const result = await fetchWhoamiViaServer(4000);
    return result?.permissions ?? fallback;
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
        let permissions = await fetchPermissions(user);
        console.info(
          '[useCurrentUser] step 1 done',
          `role=${permissions.role} sections=${permissions.sections.length}`,
        );

        // Bootstrap: if this user has no permissions yet (fresh install,
        // missing trigger, etc.) try to claim the master role. The server
        // endpoint only honors the claim when no master exists anywhere,
        // so this is a no-op on any system that already has one. We
        // intentionally avoid blocking the UI on this — if it fails the
        // user just lands without permissions and the AuthGate handles
        // it normally.
        if (permissions.role === 'user' && permissions.sections.length === 0) {
          try {
            console.info('[useCurrentUser] no perms → trying claim-master');
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            const res = await authFetch('/api/admin/claim-master', {
              method: 'POST',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            }).finally(() => clearTimeout(t));
            if (res.ok) {
              const payload = (await res.json()) as {
                promoted?: boolean;
                role?: string;
                sections?: string[];
              };
              if (payload.promoted && payload.role === 'master') {
                console.info('[useCurrentUser] claimed master ✓');
                permissions = {
                  ...permissions,
                  role: 'master',
                  sections: payload.sections || [],
                  updated_at: new Date().toISOString(),
                };
              } else {
                console.info('[useCurrentUser] claim-master refused (master already exists)');
              }
            } else {
              console.warn(`[useCurrentUser] claim-master HTTP ${res.status}`);
            }
          } catch (err) {
            console.warn('[useCurrentUser] claim-master threw:', err);
          }
        }

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
