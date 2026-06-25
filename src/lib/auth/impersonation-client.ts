/**
 * Client-side state for master-only impersonation.
 *
 * The chosen target is kept in localStorage under `wasabi_impersonate`. While
 * set, the global fetch interceptor (install-fetch-interceptor.ts) attaches an
 * `X-Impersonate-User` header to every same-origin /api/* call, and the server
 * — ONLY if the real caller is a master — acts as that target user.
 *
 * Switching impersonation on/off triggers a full reload so every data hook
 * (projects, funnels, permissions, …) re-fetches under the new identity.
 */

'use client';

export const IMPERSONATE_HEADER = 'X-Impersonate-User';
const STORAGE_KEY = 'wasabi_impersonate';

export interface ImpersonationTarget {
  userId: string;
  email?: string | null;
}

export function getImpersonation(): ImpersonationTarget | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationTarget;
    if (!parsed?.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Returns just the target user id (used by the fetch interceptor). */
export function getImpersonationUserId(): string | null {
  return getImpersonation()?.userId ?? null;
}

/** Start impersonating a user and reload so all data re-fetches as them. */
export function setImpersonation(target: ImpersonationTarget): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    /* localStorage full/disabled — nothing we can do */
  }
  window.location.assign('/');
}

/** Stop impersonating and reload back into the master's own view. */
export function clearImpersonation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.location.assign('/');
}
