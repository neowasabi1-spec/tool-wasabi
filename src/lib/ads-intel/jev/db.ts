/**
 * Jev DB adapter — uses Wasabi supabaseAdmin (service role).
 */
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { SupabaseClient } from '@supabase/supabase-js';

export function db(): SupabaseClient {
  return supabaseAdmin as unknown as SupabaseClient;
}

export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
