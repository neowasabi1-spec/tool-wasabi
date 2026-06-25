/**
 * Returns the current user's permissions, computed server-side using the
 * service-role client so RLS / policy bugs on `app_user_permissions`
 * can never lock us out of our own perms row.
 *
 *   GET /api/auth/whoami
 *     → 401 if no/invalid bearer token
 *     → 200 { user: {id, email}, permissions: {...} }
 *
 * This is the canonical "who am I" endpoint the client uses to populate
 * `useCurrentUser`. The previous implementation went straight to the
 * Supabase REST API with the anon key, which meant a misconfigured RLS
 * policy could silently return zero rows and demote the user to
 * role='user' + sections=[]. Going through this endpoint guarantees we
 * read the true row, RLS-free.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/server-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    user: auth.user,
    permissions: auth.permissions,
    impersonating: auth.impersonating ?? null,
  });
}
