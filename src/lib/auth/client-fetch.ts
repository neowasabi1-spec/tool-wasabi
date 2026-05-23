/**
 * Client-side `fetch` wrapper that injects the current Supabase access
 * token as `Authorization: Bearer ...`.
 *
 * Use this for any call to an `/api/...` route that runs `requireAuth()`
 * server-side. Falls back to a plain `fetch` if Supabase isn't configured
 * (dev / missing env vars) so the call still goes through and the server
 * returns a clean 401.
 */

'use client';

/**
 * Read the access_token directly from our own `wasabi_session` blob in
 * localStorage. We intentionally do NOT call `supabase.auth.getSession()`
 * here — that has been observed to hang under lock contention and we
 * already have the token cached. The session is kept in sync by
 * useCurrentUser on auth state changes.
 */
function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed.access_token || null;
  } catch {
    return null;
  }
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
