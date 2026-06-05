/**
 * PATCH /api/valchiria/funnels/[id]
 *
 * Updates the two Valchiria flags on an archived funnel.
 *   { show_in_valchiria?: boolean }  — personal visibility, any owner
 *   { share_with_users?: boolean }   — master-only opt-in. Putting it
 *                                      in the body from a non-master
 *                                      caller fails with 403.
 *
 * At least one of the two must be present. The row owner (or the
 * master) is the only one allowed to touch the row. We re-check
 * ownership inside the route rather than trusting RLS alone because
 * the admin client used here bypasses RLS on writes (canonical
 * "service-role + manual gate" pattern used elsewhere in the
 * codebase, see /api/projecthub/projects/[id]/route.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface PatchBody {
  show_in_valchiria?: boolean;
  share_with_users?: boolean;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'missing_id' }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as PatchBody;
    const hasShow = typeof body.show_in_valchiria === 'boolean';
    const hasShare = typeof body.share_with_users === 'boolean';
    if (!hasShow && !hasShare) {
      return NextResponse.json(
        {
          error: 'invalid_body',
          message: 'Expected at least one of { show_in_valchiria, share_with_users }',
        },
        { status: 400 },
      );
    }

    const ctx = await getUserAccessContext(req);

    // Auth: refuse anonymous/no-JWT writes outright so the worker can
    // never accidentally promote rows.
    if (!ctx.userId) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // Only the master can flip the shared-library switch.
    if (hasShare && !ctx.isMaster) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only the master can change share_with_users' },
        { status: 403 },
      );
    }

    // Ownership check for non-master: they can only touch rows they own.
    if (!ctx.isMaster) {
      const { data: row, error: lookupErr } = await supabaseAdmin
        .from('archived_funnels')
        .select('owner_user_id')
        .eq('id', id)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      if (row.owner_user_id !== ctx.userId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
    }

    const update: PatchBody = {};
    if (hasShow) update.show_in_valchiria = body.show_in_valchiria;
    if (hasShare) update.share_with_users = body.share_with_users;

    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .update(update)
      .eq('id', id)
      .select('id, show_in_valchiria, share_with_users')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, ...data });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
