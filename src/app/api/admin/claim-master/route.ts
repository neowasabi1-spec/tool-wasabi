/**
 * One-shot bootstrap endpoint: lets the FIRST authenticated user claim
 * the master role.
 *
 *   POST /api/admin/claim-master
 *     → 200 { promoted: true, role: 'master', sections: [...all] }
 *         when no master exists in `app_user_permissions` yet
 *     → 200 { promoted: false, reason: 'master_already_exists' }
 *         when at least one master is already set up
 *     → 401 when the caller isn't authenticated
 *
 * Rationale: after the first login on a fresh install, the database has
 * an `auth.users` row but no `app_user_permissions` row (or one with
 * role='user'). Without a master nobody can promote anyone via the admin
 * UI, so we bake in a self-bootstrap path that ONLY works while the
 * master slot is empty. Once any master exists this endpoint becomes a
 * no-op — subsequent users have to be invited by a master via
 * /admin/users.
 *
 * Security:
 *   - Requires a valid bearer token (so a random visitor can't claim
 *     master without first logging in via the regular Supabase Auth
 *     flow).
 *   - The "no master exists" check uses the service-role client so it
 *     bypasses RLS and gives a truthful count even when the caller
 *     can't read the table directly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth/server-guard';
import { ALL_SECTION_IDS } from '@/lib/auth/sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Caller is already a master → nothing to do.
  if (auth.permissions.role === 'master') {
    return NextResponse.json({
      promoted: false,
      reason: 'already_master',
      role: 'master',
      sections: auth.permissions.sections,
    });
  }

  // Does ANY master exist anywhere in the system?
  const { count, error: countErr } = await supabaseAdmin
    .from('app_user_permissions')
    .select('user_id', { count: 'exact', head: true })
    .eq('role', 'master');
  if (countErr) {
    return NextResponse.json(
      { error: 'count_failed', message: countErr.message },
      { status: 500 },
    );
  }

  if ((count ?? 0) > 0) {
    return NextResponse.json({
      promoted: false,
      reason: 'master_already_exists',
    });
  }

  // No master yet → promote the caller with full section access.
  const { error: upsertErr } = await supabaseAdmin
    .from('app_user_permissions')
    .upsert(
      {
        user_id: auth.user.id,
        role: 'master',
        sections: ALL_SECTION_IDS,
      },
      { onConflict: 'user_id' },
    );
  if (upsertErr) {
    return NextResponse.json(
      { error: 'upsert_failed', message: upsertErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    promoted: true,
    role: 'master',
    sections: ALL_SECTION_IDS,
  });
}
