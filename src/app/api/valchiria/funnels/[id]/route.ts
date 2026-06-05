/**
 * PATCH /api/valchiria/funnels/[id]
 *
 * Three independent flags can be sent (at least one is required):
 *
 *   { show_in_valchiria?: boolean }
 *       Personal visibility on the row itself — only the row owner
 *       (or the master) can change this. Used for funnels the caller
 *       OWNS.
 *
 *   { share_with_users?: boolean }
 *       Master-only opt-in switch. When TRUE on a master-owned row,
 *       every other authenticated user sees the row read-only in
 *       their My Archive. Non-master callers get 403 if they try.
 *
 *   { in_my_valchiria?: boolean }
 *       Caller-side preference: "I want this row to appear in MY
 *       /protocollo-valchiria". When the caller owns the row it
 *       collapses to `show_in_valchiria`. When the caller does NOT
 *       own it (shared library row), we insert/delete a row in
 *       `valchiria_user_picks` instead, which is a per-user junction.
 *       This is the flag the UI's "Add to Valchiria" toggle uses, so
 *       it Just Works regardless of ownership.
 *
 * The admin client below bypasses RLS, so every branch re-checks
 * ownership manually (canonical service-role + manual-gate pattern,
 * see /api/projecthub/projects/[id]/route.ts).
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
  in_my_valchiria?: boolean;
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
    const hasMine = typeof body.in_my_valchiria === 'boolean';
    if (!hasShow && !hasShare && !hasMine) {
      return NextResponse.json(
        {
          error: 'invalid_body',
          message:
            'Expected at least one of { show_in_valchiria, share_with_users, in_my_valchiria }',
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

    // Fetch the row once — we need to know who owns it for both the
    // ownership gate and the in_my_valchiria branch routing.
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('archived_funnels')
      .select('owner_user_id, share_with_users')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const callerOwnsRow = row.owner_user_id === ctx.userId;
    const isMasterRow = row.owner_user_id !== null && !callerOwnsRow && row.share_with_users === true;

    // Direct row-level updates are reserved for owner/master.
    if ((hasShow || hasShare) && !callerOwnsRow && !ctx.isMaster) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const update: Pick<PatchBody, 'show_in_valchiria' | 'share_with_users'> = {};
    if (hasShow) update.show_in_valchiria = body.show_in_valchiria;
    if (hasShare) update.share_with_users = body.share_with_users;

    // Translate in_my_valchiria into the right primitive:
    //   - caller owns the row → equivalent to show_in_valchiria
    //   - row is a shared-library row visible to caller → manage a
    //     personal pick in valchiria_user_picks
    //   - any other combo (e.g. a row the caller cannot see) → 403
    let pickAction: 'insert' | 'delete' | null = null;
    if (hasMine) {
      if (callerOwnsRow || ctx.isMaster) {
        update.show_in_valchiria = body.in_my_valchiria;
      } else if (isMasterRow) {
        pickAction = body.in_my_valchiria ? 'insert' : 'delete';
      } else {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
    }

    if (Object.keys(update).length > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('archived_funnels')
        .update(update)
        .eq('id', id);
      if (updErr) throw updErr;
    }

    if (pickAction === 'insert') {
      // Upsert: ON CONFLICT do nothing — composite PK on (user_id,
      // funnel_id) makes this idempotent.
      const { error: pickErr } = await supabaseAdmin
        .from('valchiria_user_picks')
        .upsert(
          { user_id: ctx.userId, funnel_id: id },
          { onConflict: 'user_id,funnel_id', ignoreDuplicates: true },
        );
      if (pickErr) throw pickErr;
    } else if (pickAction === 'delete') {
      const { error: pickErr } = await supabaseAdmin
        .from('valchiria_user_picks')
        .delete()
        .eq('user_id', ctx.userId)
        .eq('funnel_id', id);
      if (pickErr) throw pickErr;
    }

    // Recompute the resolved flag for the caller so the client can
    // update its local state without a refetch.
    const isInMyValchiria = (() => {
      if (callerOwnsRow || ctx.isMaster) {
        return update.show_in_valchiria ?? body.show_in_valchiria ?? false;
      }
      if (pickAction === 'insert') return true;
      if (pickAction === 'delete') return false;
      return undefined;
    })();

    return NextResponse.json({
      success: true,
      id,
      ...(hasShow ? { show_in_valchiria: body.show_in_valchiria } : {}),
      ...(hasShare ? { share_with_users: body.share_with_users } : {}),
      ...(typeof isInMyValchiria === 'boolean' ? { isInMyValchiria } : {}),
    });
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
