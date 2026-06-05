/**
 * Project sharing — master-only API to grant / revoke per-user
 * collaborative access on a single project.
 *
 *   GET    /api/projecthub/projects/:id/shares
 *     → { shares: [{ user_id, email, shared_at }] }
 *
 *   PUT    /api/projecthub/projects/:id/shares
 *     body: { user_ids: string[] }     (full replace; idempotent)
 *     → { shares: [...same as GET...] }
 *
 * The matching SQL RLS lives in supabase-migration-project-shares.sql.
 * Mutations require role='master'; reads also require master (a regular
 * user doesn't need to see who else has access to a project they
 * collaborate on — that's the master's call).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireMaster } from '@/lib/auth/server-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface ShareRow {
  user_id: string;
  email: string | null;
  shared_at: string;
}

async function loadShares(projectId: string): Promise<ShareRow[]> {
  const { data, error } = await supabaseAdmin
    .from('project_shares')
    .select('user_id, shared_at')
    .eq('project_id', projectId);
  if (error || !data || data.length === 0) return [];

  const userIds = data.map((r) => r.user_id);
  const emailById = new Map<string, string>();
  try {
    // Best-effort email lookup. listUsers paginates at perPage; 1000
    // is the cap and matches what /api/admin/users uses elsewhere.
    const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    for (const u of usersPage?.users || []) {
      if (u.id && userIds.includes(u.id) && u.email) {
        emailById.set(u.id, u.email);
      }
    }
  } catch {
    // Auth lookup failure → return shares with email=null and let the
    // UI fall back to a UUID prefix label.
  }

  return data
    .map((r) => ({
      user_id: r.user_id,
      email: emailById.get(r.user_id) || null,
      shared_at: r.shared_at,
    }))
    .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  // Sanity check: project must exist (avoid silent empty responses on
  // bogus IDs).
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const shares = await loadShares(params.id);
  return NextResponse.json({ shares });
}

interface PutBody {
  user_ids?: string[];
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireMaster(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as PutBody;
  if (!Array.isArray(body.user_ids)) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Expected { user_ids: string[] }' },
      { status: 400 },
    );
  }

  // Project must exist.
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('id, owner_user_id')
    .eq('id', params.id)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Don't allow sharing a project WITH its owner — meaningless and
  // would create a confusing duplicate badge in the UI.
  const ownerId = (project as { owner_user_id?: string }).owner_user_id;
  const desired = Array.from(new Set(body.user_ids.filter((id) => id && id !== ownerId)));

  // Full replace: read current, compute add/remove diff, apply.
  const { data: currentRows } = await supabaseAdmin
    .from('project_shares')
    .select('user_id')
    .eq('project_id', params.id);
  const current = new Set<string>(
    ((currentRows || []) as { user_id: string }[]).map((r) => r.user_id),
  );
  const next = new Set<string>(desired);

  const toAdd = desired.filter((id) => !current.has(id));
  const toRemove = Array.from(current).filter((id) => !next.has(id));

  if (toAdd.length > 0) {
    const rows = toAdd.map((user_id) => ({
      project_id: params.id,
      user_id,
      shared_by: auth.user.id,
    }));
    const { error: insErr } = await supabaseAdmin
      .from('project_shares')
      .insert(rows);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  if (toRemove.length > 0) {
    const { error: delErr } = await supabaseAdmin
      .from('project_shares')
      .delete()
      .eq('project_id', params.id)
      .in('user_id', toRemove);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
  }

  const shares = await loadShares(params.id);
  return NextResponse.json({ shares });
}
