'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let singleton: SupabaseClient | null = null;

/**
 * Client browser-only: non chiamare createClient a livello di modulo (rompe `next build` su CI se mancano le env).
 */
function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * No-op lock. supabase-js v2.40+ wraps `getSession`/`signInWithPassword`/etc.
 * with `navigator.locks` to coordinate session access across tabs. That
 * lock can get orphaned after a SOFT React/Next route change (e.g. our
 * AuthGate's `router.replace('/login')`) because the page never fully
 * reloads — the lock holder is gone but the lock entry isn't cleared,
 * and every subsequent `getSession()` waits forever for it. Disabling
 * the lock removes the deadlock at the cost of a (very rare) race
 * between two tabs refreshing the token at the exact same moment, which
 * the SDK handles gracefully anyway.
 *
 * See: https://github.com/supabase/auth-js/issues/762
 */
async function noopLock<R>(
  _name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>,
): Promise<R> {
  return fn();
}

export function getSupabaseBrowser(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key || !isValidHttpUrl(url)) return null;
  if (!singleton) {
    singleton = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        lock: noopLock,
      },
    });
  }
  return singleton;
}
