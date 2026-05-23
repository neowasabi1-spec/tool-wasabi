/**
 * Admin endpoint — manage app users.
 *
 *   GET  /api/admin/users          → list of { id, email, last_sign_in_at,
 *                                              role, sections, created_at }
 *   POST /api/admin/users          → { email, password, sections, role? }
 *                                    creates the auth.users row + the
 *                                    app_user_permissions row in one shot
 *                                    using the service-role admin API
 *
 * Both require the caller to have role='master' (see `requireMaster`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireMaster } from '@/lib/auth/server-guard';
import {
  ALL_SECTION_IDS,
  type AppRole,
  type AppUserWithEmail,
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

function sanitizeRole(input: unknown): AppRole {
  return input === 'master' ? 'master' : 'user';
}

export async function GET(req: NextRequest) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  // 1) pull every auth user (the admin API is paginated; 1000 is the cap
  //    Supabase enforces — for typical single-tenant Wasabi installs this
  //    is more than enough)
  const { data: usersPage, error: usersErr } =
    await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersErr) {
    return NextResponse.json({ error: usersErr.message }, { status: 500 });
  }

  // 2) join with our permissions table
  const { data: perms, error: permsErr } = await supabaseAdmin
    .from('app_user_permissions')
    .select('*');
  if (permsErr) {
    return NextResponse.json({ error: permsErr.message }, { status: 500 });
  }
  const permsById = new Map<string, { role: AppRole; sections: string[]; created_at: string; updated_at: string }>();
  for (const p of perms || []) {
    permsById.set(p.user_id, p);
  }

  const merged: AppUserWithEmail[] = (usersPage?.users || []).map(u => {
    const p = permsById.get(u.id);
    return {
      user_id: u.id,
      email: u.email || '',
      last_sign_in_at: u.last_sign_in_at || null,
      role: (p?.role as AppRole) || 'user',
      sections: p?.sections || [],
      created_at: p?.created_at || u.created_at,
      updated_at: p?.updated_at || u.created_at,
    };
  });

  // newest first
  merged.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));

  return NextResponse.json({ users: merged });
}

interface CreateUserBody {
  email?: string;
  password?: string;
  role?: AppRole;
  sections?: string[];
}

export async function POST(req: NextRequest) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  let body: CreateUserBody = {};
  try { body = await req.json(); } catch { /* keep empty */ }

  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters' },
      { status: 400 },
    );
  }

  const role = sanitizeRole(body.role);
  const sections = role === 'master' ? ALL_SECTION_IDS : sanitizeSections(body.sections);

  // 1) create the Supabase auth user (auto-confirm so they can log in
  //    immediately with the password the master typed)
  const { data: created, error: createErr } =
    await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createErr || !created?.user) {
    return NextResponse.json(
      { error: createErr?.message || 'Failed to create user' },
      { status: 500 },
    );
  }

  // 2) upsert the permissions row. The trigger may have already created
  //    a default row (role='user', sections=[]) — upsert overwrites it
  //    with whatever the master chose.
  const { error: upsertErr } = await supabaseAdmin
    .from('app_user_permissions')
    .upsert(
      { user_id: created.user.id, role, sections },
      { onConflict: 'user_id' },
    );
  if (upsertErr) {
    // Try to roll back the auth user so we don't leave orphans the
    // master can't easily clean up via UI.
    await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    user: {
      user_id: created.user.id,
      email: created.user.email,
      role,
      sections,
    },
  });
}
