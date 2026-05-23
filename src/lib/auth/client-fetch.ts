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

import { getSupabaseBrowser } from '@/lib/supabase-browser';

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const supabase = getSupabaseBrowser();
  let token: string | null = null;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? null;
  }

  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
