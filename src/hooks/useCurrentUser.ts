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

  const fetchPermissions = useCallback(async (user: User) => {
    const supabase = getSupabaseBrowser();
    if (!supabase) return null;
    const { data: row } = await supabase
      .from('app_user_permissions')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (row) return row as AppUserPermissions;
    // No row yet — synthesize a non-master with zero sections so the
    // AuthGate routes them to /no-access instead of crashing.
    return {
      user_id: user.id,
      role: 'user' as AppRole,
      sections: [] as string[],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies AppUserPermissions;
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      const { data: session } = await supabase.auth.getSession();
      const user = session.session?.user ?? null;
      if (!user) {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
        return;
      }
      const permissions = await fetchPermissions(user);
      if (!cancelled && permissions) {
        setData({ user, permissions });
      }
      if (!cancelled) setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (cancelled) return;
      const user = session?.user ?? null;
      if (!user) {
        setData(null);
        return;
      }
      const permissions = await fetchPermissions(user);
      if (permissions) setData({ user, permissions });
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [fetchPermissions]);

  return { ...(data ? data : { user: null, permissions: null }), loading };
}
