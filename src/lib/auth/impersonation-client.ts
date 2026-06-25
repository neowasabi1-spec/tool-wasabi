/**
 * Client-side state for master-only impersonation (token swap).
 *
 * When a master impersonates a user we ask the server (master-only) to mint a
 * REAL session for that user, then store it as the active `wasabi_session`
 * — backing up the master's own session under `wasabi_session_master`. This
 * is required because the browser's Supabase client reads most data DIRECTLY
 * from Supabase under RLS using `wasabi_session.access_token`; only swapping
 * the JWT makes those direct reads return the target user's data. Exiting
 * restores the master session.
 *
 * `wasabi_impersonate` holds { userId, email } purely so the banner can show
 * who we're impersonating; the real identity is carried by the swapped JWT.
 */

'use client';

import { authFetch } from './client-fetch';

export const IMPERSONATE_HEADER = 'X-Impersonate-User';
const SESSION_KEY = 'wasabi_session';
const MASTER_BACKUP_KEY = 'wasabi_session_master';
const FLAG_KEY = 'wasabi_impersonate';

export interface ImpersonationTarget {
  userId: string;
  email?: string | null;
}

export function getImpersonation(): ImpersonationTarget | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FLAG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationTarget;
    if (!parsed?.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Target user id (used by the fetch interceptor as a secondary signal). */
export function getImpersonationUserId(): string | null {
  return getImpersonation()?.userId ?? null;
}

/**
 * Start impersonating a user: mint their session server-side, swap it into
 * localStorage (backing up the master's), then reload so every data hook —
 * including direct Supabase reads — re-fetches as the target user.
 */
export async function startImpersonation(userId: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const res = await authFetch('/api/admin/impersonate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetUserId: userId }),
  });
  let data: { session?: unknown; email?: string | null; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !data?.session) {
    throw new Error(data?.error || `Impersonation failed (HTTP ${res.status})`);
  }

  // Back up the master's own session exactly once (don't overwrite an
  // existing backup if somehow already impersonating).
  const current = window.localStorage.getItem(SESSION_KEY);
  if (current && !window.localStorage.getItem(MASTER_BACKUP_KEY)) {
    window.localStorage.setItem(MASTER_BACKUP_KEY, current);
  }

  window.localStorage.setItem(SESSION_KEY, JSON.stringify(data.session));
  window.localStorage.setItem(
    FLAG_KEY,
    JSON.stringify({ userId, email: data.email ?? null }),
  );
  window.location.assign('/');
}

/** Stop impersonating: restore the master session and reload. */
export function clearImpersonation(): void {
  if (typeof window === 'undefined') return;
  const master = window.localStorage.getItem(MASTER_BACKUP_KEY);
  if (master) {
    window.localStorage.setItem(SESSION_KEY, master);
  }
  window.localStorage.removeItem(MASTER_BACKUP_KEY);
  window.localStorage.removeItem(FLAG_KEY);
  window.location.assign('/');
}
