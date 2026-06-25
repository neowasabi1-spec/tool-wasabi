/**
 * Global `window.fetch` interceptor that auto-injects the current Supabase
 * access token as `Authorization: Bearer ...` on every same-origin `/api/*`
 * call.
 *
 * Why we need this
 * ────────────────
 * Most components in this codebase call `fetch('/api/...')` directly instead
 * of going through `authFetch()` from `client-fetch.ts`. That means none of
 * those requests carry the Supabase JWT, and server-side route handlers see
 * `auth.uid()` as null. With multi-tenancy enabled, that breaks
 * `getUserAccessContext()` (which falls back to "no filter") and a regular
 * user ends up seeing the master's data.
 *
 * Rather than refactor ~40 fetch call sites to use `authFetch`, we install a
 * single interceptor once on app boot. It is a thin, behaviour-preserving
 * monkey-patch:
 *
 *  - Only same-origin `/api/*` URLs are touched.
 *  - If an explicit `Authorization` header was already set on the request,
 *    we leave it alone (don't clobber bespoke auth).
 *  - External hosts (Supabase REST, OpenClaw, Telegram, Anthropic, …) are
 *    untouched, so we never leak the JWT outside our origin.
 *  - The Supabase JS client uses `window.fetch` internally too, but it
 *    targets the Supabase REST URL, not `/api/...`, so it stays unaffected.
 *
 * Token source
 * ────────────
 * We read `wasabi_session.access_token` from `localStorage`. That is the
 * same key `useCurrentUser` and `authFetch` already use, so a single login
 * surfaces the token to every component path.
 *
 * Idempotency
 * ───────────
 * The patch is installed at most once per page load. A `__wasabiAuthFetchInstalled`
 * flag on `window` guards against double-installation during HMR or React's
 * strict-mode double-mount.
 */

'use client';

import { IMPERSONATE_HEADER, getImpersonationUserId } from './impersonation-client';

interface StoredSession {
  access_token?: string;
}

function readAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed?.access_token || null;
  } catch {
    return null;
  }
}

function inputUrlString(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  } catch {
    /* ignore */
  }
  return null;
}

function isSameOriginApiPath(input: RequestInfo | URL): boolean {
  const url = inputUrlString(input);
  if (!url) return false;
  if (url.startsWith('/api/')) return true;
  try {
    if (url.startsWith(window.location.origin + '/api/')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function installAuthFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & { __wasabiAuthFetchInstalled?: boolean };
  if (w.__wasabiAuthFetchInstalled) return;
  w.__wasabiAuthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!isSameOriginApiPath(input)) {
      return originalFetch(input, init);
    }

    const initHeaders = new Headers(init?.headers || {});
    const requestHasAuth =
      initHeaders.has('Authorization') ||
      (typeof Request !== 'undefined' &&
        input instanceof Request &&
        input.headers.has('Authorization'));

    const token = readAccessToken();
    const impersonateId = getImpersonationUserId();

    // Nothing to add: no token to inject (request may already carry its own
    // auth) AND no impersonation in effect → leave the request untouched.
    if ((requestHasAuth || !token) && !impersonateId) {
      return originalFetch(input, init);
    }

    // Merge headers from both the Request (if any) and the init bag, then
    // add Authorization (only if missing) and the impersonation header. The
    // merged Headers object is what we hand back so neither source clobbers
    // the other.
    const merged = new Headers();
    if (typeof Request !== 'undefined' && input instanceof Request) {
      input.headers.forEach((value, key) => merged.set(key, value));
    }
    initHeaders.forEach((value, key) => merged.set(key, value));

    // Inject the master/user bearer token unless the caller set its own.
    if (token && !merged.has('Authorization')) {
      merged.set('Authorization', `Bearer ${token}`);
    }
    // Master-only impersonation: the server ignores this header unless the
    // real bearer token belongs to a master, so it can't escalate.
    if (impersonateId) {
      merged.set(IMPERSONATE_HEADER, impersonateId);
    }

    return originalFetch(input, { ...(init || {}), headers: merged });
  };
}
