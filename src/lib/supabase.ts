import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/**
 * On the browser, we keep our own copy of the access token under
 * `localStorage.wasabi_session` (see `LoginPageClient.tsx` and
 * `useCurrentUser.ts`). We intentionally skipped `supabase.auth.setSession`
 * because it triggers a /user verification call that has historically
 * hung on lock contention.
 *
 * Side-effect of that decision: the Supabase JS client never picks up the
 * JWT, so every `supabase.from(...).select()` call from a component goes
 * out as the anon role. With RLS off that's invisible; with RLS on
 * (multi-tenancy) it means `auth.uid()` is null on the database and our
 * policies grant either NO access (strict mode) or "see everything" (the
 * temporary `OR auth.uid() IS NULL` fallback in phase 1).
 *
 * Either failure mode is catastrophic for a multi-tenant rollout, so here
 * we splice the Bearer token into every Supabase HTTP call ourselves. This
 * matches what `setSession` would have done at the network layer without
 * any of the verification round-trip overhead.
 */
function readWasabiAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('wasabi_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed?.access_token || null;
  } catch {
    return null;
  }
}

function getClient(): SupabaseClient {
  if (_client) return _client;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }

  // Force every Supabase HTTP call to bypass Next 14's data cache.
  // The default `fetch` in Next 14 Route Handlers caches GET responses
  // unless you explicitly opt out, which means the polling endpoint
  // for funnel-crawl status was happily returning a "still running"
  // snapshot for minutes after the worker had written `completed` to
  // Supabase. Wrapping fetch with `cache: 'no-store'` makes the entire
  // codebase immune to this class of bug.
  //
  // We also stitch in the wasabi_session JWT as the bearer token if
  // present and not already overridden — see comment block above for
  // the multi-tenancy rationale. The auth endpoints (`/auth/v1/...`)
  // are left untouched so password/magic-link flows still use the anon
  // key (which is the documented behaviour for those endpoints).
  const noStoreAuthFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers || {});
    const urlString = (() => {
      try {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.toString();
        if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      } catch {
        /* ignore */
      }
      return '';
    })();
    const isAuthEndpoint = urlString.includes('/auth/v1/');
    if (!isAuthEndpoint && !headers.has('Authorization')) {
      const token = readWasabiAccessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers, cache: 'no-store' });
  };

  _client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: noStoreAuthFetch },
    // We manage tokens ourselves in `wasabi_session`. Disabling these flags
    // prevents the SDK from spawning its own auth listeners that race with
    // our manual rehydration and from writing duplicate keys to localStorage.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return _client;
}

// Lazy init: client creato al primo uso (runtime), non al load del modulo → build OK senza env
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// Helper function to check connection
export async function checkSupabaseConnection(): Promise<{
  connected: boolean;
  error?: string;
}> {
  try {
    const { error } = await supabase.from('products').select('count').limit(1);
    if (error && error.code !== 'PGRST116') {
      // PGRST116 = table doesn't exist, which is expected if not created yet
      return { connected: false, error: error.message };
    }
    return { connected: true };
  } catch (err) {
    return { 
      connected: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    };
  }
}
