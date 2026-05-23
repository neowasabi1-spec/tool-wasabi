/**
 * Admin endpoint — update / delete a specific user.
 *
 *   PATCH  /api/admin/users/[id]   → { role?, sections?, password? }
 *                                    update permissions and/or reset
 *                                    the password
 *   DELETE /api/admin/users/[id]   → remove the auth.users row AND the
 *                                    app_user_permissions row (cascades)
 *
 * Both require role='master'. The endpoint refuses to demote / delete
 * the LAST master so the workspace can never be locked out.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireMaster } from '@/lib/auth/server-guard';
import {
  ALL_SECTION_IDS,
  type AppRole,
} from '@/lib/auth/sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sanitizeSections(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(ALL_SECTION_IDS);
  return input
    .map(v => (typeof v === 'string' ? v : ''))
    .filter(v => allowed.has(v));
}

async function countMasters(): Promise<number> {
  const { count } = await supabaseAdmin
    .from('app_user_permissions')
    .select('user_id', { count: 'exact', head: true })
    .eq('role', 'master');
  return count || 0;
}

async function getRoleOf(userId: string): Promise<AppRole | null> {
  const { data } = await supabaseAdmin
    .from('app_user_permissions')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.role as AppRole | undefined) ?? null;
}

interface PatchBody {
  role?: AppRole;
  sections?: string[];
  password?: string;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  const targetId = params.id;
  let body: PatchBody = {};
  try { body = await req.json(); } catch { /* keep empty */ }

  const targetRole = await getRoleOf(targetId);
  const newRole: AppRole | undefined =
    body.role === 'master' || body.role === 'user' ? body.role : undefined;

  // Safety: never demote / disable the only remaining master.
  if (newRole === 'user' && targetRole === 'master') {
    const masters = await countMasters();
    if (masters <= 1) {
      return NextResponse.json(
        { error: 'Cannot demote the last master — promote another user first.' },
        { status: 400 },
      );
    }
  }

  // Build the update payload for permissions.
  const update: Record<string, unknown> = {};
  if (newRole) update.role = newRole;
  if ('sections' in body) {
    update.sections = newRole === 'master'
      ? ALL_SECTION_IDS
      : sanitizeSections(body.sections);
  } else if (newRole === 'master') {
    // Promoted to master without explicit sections → grant all.
    update.sections = ALL_SECTION_IDS;
  }

  if (Object.keys(update).length > 0) {
    const { error: upErr } = await supabaseAdmin
      .from('app_user_permissions')
      .upsert(
        { user_id: targetId, ...update },
        { onConflict: 'user_id' },
      );
    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }
  }

  // Optional password reset.
  if (body.password) {
    if (body.password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }
    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(
      targetId,
      { password: body.password },
    );
    if (pwErr) {
      return NextResponse.json({ error: pwErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  const targetId = params.id;

  // Refuse to delete the only remaining master OR the master deleting
  // themselves if they're the last one.
  const targetRole = await getRoleOf(targetId);
  if (targetRole === 'master') {
    const masters = await countMasters();
    if (masters <= 1) {
      return NextResponse.json(
        { error: 'Cannot delete the last master — promote another user first.' },
        { status: 400 },
      );
    }
  }

  // ON DELETE CASCADE on app_user_permissions.user_id handles the perm
  // row automatically when the auth user is removed.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(targetId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
