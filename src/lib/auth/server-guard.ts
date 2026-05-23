/**
 * Server-side guard used by API routes to enforce permissions.
 *
 * Usage in an API route:
 *
 *   const auth = await requireAuth(req);
 *   if (!auth.ok) return auth.response;
 *   if (!canAccessSection(auth.permissions, 'admin-users')) {
 *     return NextResponse.json({ error: 'forbidden' }, { status: 403 });
 *   }
 *   // auth.user.id / auth.permissions.* available
 *
 * Auth comes from the `Authorization: Bearer <access_token>` header that
 * the client sends with every fetch (set up automatically by the
 * `authFetch()` helper in `src/lib/auth/client-fetch.ts`).
 *
 * We deliberately use the SERVICE ROLE client to verify the token —
 * `supabase.auth.getUser(token)` works with any role but using the admin
 * client guarantees we can also read `app_user_permissions` without RLS
 * fights when the user's own row hasn't been created yet (e.g. right
 * after Supabase Auth created an auth.users row but the trigger lagged).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppUserPermissions, AppRole } from './sections';

export interface AuthOk {
  ok: true;
  user: { id: string; email: string | null };
  permissions: AppUserPermissions;
}

export interface AuthFail {
  ok: false;
  response: NextResponse;
}

export type AuthResult = AuthOk | AuthFail;

/** Extract the access token from either `Authorization: Bearer ...` or
 *  the `sb-access-token` cookie (set by the Supabase JS client when
 *  `persistSession: true`). Returns null if neither is present. */
function extractAccessToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  // Fallback to cookie names used by supabase-js when storing the session
  // in cookies. We try both the modern name and the legacy one.
  const cookieToken = req.cookies.get('sb-access-token')?.value;
  if (cookieToken) return cookieToken;
  return null;
}

export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  const token = extractAccessToken(req);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unauthorized', reason: 'missing access token' },
        { status: 401 },
      ),
    };
  }

  // Verify the JWT and get the user.
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unauthorized', reason: userErr?.message || 'invalid token' },
        { status: 401 },
      ),
    };
  }

  const userId = userData.user.id;
  const email = userData.user.email ?? null;

  // Look up permissions. If the row is missing (trigger lagged, or older
  // data) we synthesize a 'user' with zero sections so downstream code
  // doesn't crash — the AuthGate will then send them to /no-access.
  const { data: permRow } = await supabaseAdmin
    .from('app_user_permissions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const permissions: AppUserPermissions = permRow ?? {
    user_id: userId,
    role: 'user' as AppRole,
    sections: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return { ok: true, user: { id: userId, email }, permissions };
}

/** Convenience guard: require auth AND the master role. Returns the same
 *  AuthOk shape on success or a 403/401 response on failure. */
export async function requireMaster(req: NextRequest): Promise<AuthResult> {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth;
  if (auth.permissions.role !== 'master') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden', reason: 'master role required' },
        { status: 403 },
      ),
    };
  }
  return auth;
}
