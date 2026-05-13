import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

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
  const noStoreFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, cache: 'no-store' });
  _client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: noStoreFetch },
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
