/**
 * Server-side Supabase client that uses the SERVICE ROLE key.
 *
 * Use this for any backend operation that needs to:
 *   - bypass RLS (Row Level Security) on tables
 *   - read/write to Supabase Storage buckets that aren't fully public
 *   - create/configure buckets, manage policies, etc.
 *
 * Falls back to the anon key when SUPABASE_SERVICE_ROLE_KEY isn't set so
 * code keeps running in dev / preview environments — but logs a warning so
 * we notice the misconfiguration.
 *
 * NEVER import this from client components — Next.js will leak the
 * SUPABASE_SERVICE_ROLE_KEY into the client bundle. The check at the top
 * throws at construction time if `window` is defined as a defensive guard.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;
let _warnedAnonFallback = false;

function buildClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      '[supabase-admin] This module must NEVER be imported from client code',
    );
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      '[supabase-admin] NEXT_PUBLIC_SUPABASE_URL is not configured',
    );
  }

  const key = serviceKey || anonKey;
  if (!key) {
    throw new Error(
      '[supabase-admin] Neither SUPABASE_SERVICE_ROLE_KEY nor NEXT_PUBLIC_SUPABASE_ANON_KEY is configured',
    );
  }

  if (!serviceKey && !_warnedAnonFallback) {
    _warnedAnonFallback = true;
    console.warn(
      '[supabase-admin] SUPABASE_SERVICE_ROLE_KEY missing — falling back to anon key. Storage uploads and other RLS-protected ops will likely fail.',
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Match the rest of the app and bypass Next 14's data cache so we never
    // serve a stale snapshot from a route handler.
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}

export function getSupabaseAdmin(): SupabaseClient {
  if (!_client) _client = buildClient();
  return _client;
}

/** Has SUPABASE_SERVICE_ROLE_KEY been provided? Useful for surfacing
 *  config errors to the user when uploads start failing in production. */
export function hasServiceRoleKey(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Convenience proxy so existing `import { supabase } from '...'` patterns
 *  port cleanly. Lazy-inits on first property access. */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    const client = getSupabaseAdmin();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
