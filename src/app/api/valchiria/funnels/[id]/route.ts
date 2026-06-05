/**
 * PATCH /api/valchiria/funnels/[id]
 *
 * Toggles whether an archived funnel surfaces inside Protocollo
 * Valchiria. Body: `{ show_in_valchiria: boolean }`.
 *
 * Only the row owner (or the master) can flip the flag. We re-check
 * ownership inside the route rather than trusting RLS alone, because
 * the admin client we use bypasses RLS on writes — this is the
 * canonical "service-role + manual gate" pattern used elsewhere in
 * the codebase (see /api/projecthub/projects/[id]/route.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface PatchBody {
  show_in_valchiria?: boolean;
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
    if (typeof body.show_in_valchiria !== 'boolean') {
      return NextResponse.json(
        { error: 'invalid_body', message: 'Expected { show_in_valchiria: boolean }' },
        { status: 400 },
      );
    }

    const ctx = await getUserAccessContext(req);

    // Ownership check: master can flip anything, regular user only
    // their own. We refuse anonymous/no-JWT writes outright here to
    // avoid letting the worker accidentally promote rows.
    if (!ctx.userId) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
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

    const { data, error } = await supabaseAdmin
      .from('archived_funnels')
      .update({ show_in_valchiria: body.show_in_valchiria })
      .eq('id', id)
      .select('id, show_in_valchiria')
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
