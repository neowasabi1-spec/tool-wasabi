/**
 * Bootstrap endpoint that grants the master role.
 *
 *   POST /api/admin/claim-master
 *     → 200 { promoted: true, role: 'master', sections: [...all] }
 *         when the caller is allowed to become master
 *     → 200 { promoted: false, reason: 'master_already_exists' }
 *         when there's already a master AND the caller isn't an OWNER
 *     → 401 when not authenticated
 *
 * Promotion rules (in order, first match wins):
 *   1. The caller's email is listed in OWNER_EMAILS env var (comma-
 *      separated). This always wins, even if other masters already
 *      exist — useful when you've lost master access and need to
 *      reclaim it without poking the database directly.
 *   2. No master exists in `app_user_permissions` yet (fresh install).
 *   3. Otherwise refuse.
 *
 * All DB calls use the service-role client so RLS can't lock us out
 * of the recovery path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth/server-guard';
import { ALL_SECTION_IDS } from '@/lib/auth/sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseOwnerEmails(): Set<string> {
  const raw = process.env.OWNER_EMAILS || process.env.OWNER_EMAIL || '';
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Already a master → nothing to do, just echo back current perms.
  if (auth.permissions.role === 'master') {
    return NextResponse.json({
      promoted: false,
      reason: 'already_master',
      role: 'master',
      sections: auth.permissions.sections,
    });
  }

  const owners = parseOwnerEmails();
  const callerEmail = (auth.user.email || '').toLowerCase();
  const isOwner = !!callerEmail && owners.has(callerEmail);

  // Count current masters (using service role → bypasses RLS).
  let masterExists = false;
  if (!isOwner) {
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
    masterExists = (count ?? 0) > 0;
  }

  if (masterExists) {
    return NextResponse.json({
      promoted: false,
      reason: 'master_already_exists',
    });
  }

  // Promote the caller.
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
    via: isOwner ? 'owner_override' : 'no_existing_master',
  });
}
