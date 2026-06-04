/**
 * Best-effort extraction of the caller's user UUID from an incoming
 * request, WITHOUT failing the request when no session is present.
 *
 * Used by API routes that need to set `owner_user_id` on inserts but
 * also want to keep working for legacy clients / service-role calls /
 * cron jobs that don't carry a JWT. When the caller is unauthenticated,
 * this returns `null` and the DB trigger `auto_owner_user_id()` will
 * fall back to the master account.
 *
 * If a route needs to HARD-require auth, use `requireAuth(req)` from
 * `./server-guard.ts` instead.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

function extractAccessToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const cookieToken = req.cookies.get('sb-access-token')?.value;
  if (cookieToken) return cookieToken;
  return null;
}

/**
 * Returns the authenticated user's UUID if a valid Supabase access
 * token is present on the request, or `null` otherwise.
 *
 * Never throws. Logs (debug-level) on token-verification failures so
 * we can spot widespread auth issues without blowing up the route.
 */
export async function getCurrentUserId(req: NextRequest): Promise<string | null> {
  const token = extractAccessToken(req);
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch (err) {
    // Network blip / Supabase outage — fall through to null so the
    // route can still attempt the operation (trigger will default to
    // master). The route should NOT decide auth based on this helper.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[getCurrentUserId] token verify failed:', err);
    }
    return null;
  }
}

/**
 * Resolves the caller's access context in one shot:
 *   - userId        — UUID of the authenticated user, or null
 *   - isMaster      — true if the caller has the 'master' role
 *
 * Use this in routes that need to decide between
 *   * filtering query results by `owner_user_id = userId`, vs
 *   * returning everything (master view), vs
 *   * leaving the legacy "everyone sees everything" behaviour when
 *     the caller has no session at all (no JWT) — this last branch
 *     keeps server-to-server, worker, and cron-style callers working
 *     while we incrementally tighten auth.
 *
 * Never throws.
 */
export interface UserAccessContext {
  userId: string | null;
  isMaster: boolean;
}

export async function getUserAccessContext(req: NextRequest): Promise<UserAccessContext> {
  const userId = await getCurrentUserId(req);
  if (!userId) return { userId: null, isMaster: false };
  try {
    const { data } = await supabaseAdmin
      .from('app_user_permissions')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    return { userId, isMaster: data?.role === 'master' };
  } catch {
    // Permissions table read failed — treat as plain user so the
    // route filters down to their own rows (fail-closed for safety
    // on the "master sees all" branch).
    return { userId, isMaster: false };
  }
}
