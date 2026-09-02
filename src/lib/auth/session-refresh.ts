/**
 * Proactive Supabase session refresh.
 *
 * The app stores its session in `localStorage.wasabi_session` and runs the
 * Supabase JS client with `autoRefreshToken: false` (see lib/supabase.ts for
 * why). Consequence: nothing ever renewed the access token, so after the JWT
 * expiry (30–60 min) every Supabase/REST call started failing with 401 and
 * the user was bounced back to /login.
 *
 * This module keeps the session alive indefinitely (as long as the refresh
 * token is valid — weeks/months) by refreshing the access token BEFORE it
 * expires:
 *
 *  - `ensureFreshSession()` — refreshes if the token expires within the
 *    threshold (default 10 min). Single-flight so parallel callers share
 *    one refresh (Supabase rotates refresh tokens, so N parallel refreshes
 *    would invalidate each other).
 *  - `startSessionAutoRefresh()` — installs a 60s interval plus focus /
 *    visibilitychange listeners (setInterval is throttled in background
 *    tabs and doesn't run while the laptop sleeps, so the wake-up path
 *    matters more than the timer).
 */

'use client';

import { supabase } from '@/lib/supabase';

const SESSION_KEY = 'wasabi_session';
/** Refresh when the token expires within this window. */
const REFRESH_AHEAD_MS = 10 * 60 * 1000;

interface StoredSession {
  access_token: string;
  refresh_token?: string;
  user_id?: string;
  email?: string;
  expires_at?: number; // unix seconds
}

function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.access_token ? parsed : null;
  } catch {
    return null;
  }
}

/** Milliseconds until the stored token expires. Infinity if unknown. */
function msUntilExpiry(s: StoredSession | null): number {
  if (!s) return Infinity;
  if (!s.expires_at) {
    // Legacy sessions saved without expires_at: decode the JWT `exp` claim.
    try {
      const payload = JSON.parse(atob(s.access_token.split('.')[1]));
      if (typeof payload?.exp === 'number') return payload.exp * 1000 - Date.now();
    } catch {
      /* unreadable token — treat as expiring so we refresh it */
    }
    return 0;
  }
  return s.expires_at * 1000 - Date.now();
}

export function sessionNeedsRefresh(): boolean {
  const s = readStoredSession();
  if (!s?.refresh_token) return false; // nothing we can do without one
  return msUntilExpiry(s) < REFRESH_AHEAD_MS;
}

async function doRefresh(): Promise<boolean> {
  // Re-read inside the lock: another tab may have already refreshed and
  // written a fresh session to localStorage, in which case we're done.
  const stored = readStoredSession();
  if (!stored?.refresh_token) return false;
  if (msUntilExpiry(stored) >= REFRESH_AHEAD_MS) return true;

  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: stored.refresh_token,
    });
    if (error || !data?.session?.access_token || !data?.session?.refresh_token) {
      console.warn('[session-refresh] refresh failed:', error?.message || 'no session returned');
      return false;
    }
    try {
      window.localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          user_id: data.session.user.id,
          email: data.session.user.email ?? stored.email,
          expires_at: data.session.expires_at,
        }),
      );
    } catch {
      /* storage full/blocked — token still valid in memory for this call */
    }
    return true;
  } catch (err) {
    console.warn('[session-refresh] refresh threw:', err);
    return false;
  }
}

let _inflight: Promise<boolean> | null = null;

/**
 * Refresh the session if it's expired or close to expiring. Resolves true
 * if a valid (fresh enough) session is in place afterwards. Never throws.
 */
export function ensureFreshSession(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (!sessionNeedsRefresh()) return Promise.resolve(true);
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      return await doRefresh();
    } finally {
      // Small cooldown so a burst of callers can't hammer the endpoint.
      setTimeout(() => { _inflight = null; }, 1000);
    }
  })();
  return _inflight;
}

/**
 * Install the background auto-refresh loop. Idempotent per page load.
 */
export function startSessionAutoRefresh(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __wasabiSessionRefreshInstalled?: boolean };
  if (w.__wasabiSessionRefreshInstalled) return;
  w.__wasabiSessionRefreshInstalled = true;

  // Immediate check on boot (e.g. reopening the app after hours away).
  void ensureFreshSession();

  window.setInterval(() => { void ensureFreshSession(); }, 60 * 1000);

  // Timers don't fire while the machine sleeps or the tab is heavily
  // throttled — refresh as soon as the user comes back.
  const onWake = () => { void ensureFreshSession(); };
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onWake();
  });
}
