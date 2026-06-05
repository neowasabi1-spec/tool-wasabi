/**
 * GET /api/valchiria/funnels
 *
 * Returns the union of:
 *   1. The caller's OWN archived funnels (every row they own — the
 *      caller picks from /templates whether each one should surface in
 *      Protocollo Valchiria via the `show_in_valchiria` flag, and the
 *      page filters client-side; we still ship them all so the page
 *      can show "your archive" alongside "shared library").
 *   2. The MASTER's archived funnels that have been flipped to
 *      `show_in_valchiria = TRUE` — these form the shared library
 *      every collaborator can pull from. They are read-only for
 *      non-masters (RLS prevents writes, and the UI marks them as
 *      `isShared: true` so the front-end can disable edit/delete).
 *
 * Master callers receive everything with `show_in_valchiria = TRUE`
 * (their own rows already carry isShared=false since they ARE the
 * library owner).
 *
 * Service-role / unauthenticated callers (e.g. a worker hitting this
 * endpoint without a JWT) get the legacy "see everything" behaviour
 * for backward compat, matching the phase-1 RLS fallback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface ValchiriaFunnelRow {
  id: string;
  name: string;
  total_steps: number;
  steps: unknown;
  section: string | null;
  created_at: string;
  owner_user_id: string | null;
  show_in_valchiria: boolean;
  share_with_users: boolean;
  /** TRUE when the row is part of the master's library and the caller
   *  is NOT the master. UI uses this to hide edit/delete + render the
   *  Shared badge. */
  isShared: boolean;
  /** Resolved per-caller: TRUE when the row should appear in the
   *  caller's own /protocollo-valchiria.
   *   - Own rows: equal to show_in_valchiria.
   *   - Shared rows (for non-master callers): TRUE only if the caller
   *     has explicitly picked it via the /api/valchiria/funnels/[id]
   *     PATCH endpoint. */
  isInMyValchiria: boolean;
}

const SELECT_COLS =
  'id, name, total_steps, steps, section, created_at, owner_user_id, show_in_valchiria, share_with_users';

async function getMasterId(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('app_user_permissions')
    .select('user_id')
    .eq('role', 'master')
    .limit(1)
    .maybeSingle();
  return data?.user_id ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getUserAccessContext(req);
    const masterId = await getMasterId();

    // Build the base SELECT. We always use the admin client for this
    // endpoint so we can deterministically join "own" + "shared library"
    // in a single round-trip; the per-branch filtering below replaces
    // the RLS we'd otherwise rely on.
    const baseSelect = supabaseAdmin
      .from('archived_funnels')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false });

    // Master / no-JWT branch: see everything. The "Shared" badge is a
    // hint for OTHER users that a row belongs to the master library,
    // so from the master's own perspective every row is just "mine" —
    // we always emit isShared=false here. (Same for service-role / no-
    // JWT callers: they have no user identity to compare against, so
    // the badge would be meaningless.)
    if (ctx.isMaster || !ctx.userId) {
      const { data, error } = await baseSelect;
      if (error) throw error;
      const rows: ValchiriaFunnelRow[] = (data || []).map((r) => ({
        ...r,
        isShared: false,
        // The master uses show_in_valchiria directly. No picks needed.
        isInMyValchiria: !!r.show_in_valchiria,
      }));
      return NextResponse.json({ success: true, funnels: rows });
    }

    // Regular user branch: own rows + master's shared library.
    // The "shared library" is gated on `share_with_users = TRUE` (master
    // opt-in); each shared row appears in My Archive but does NOT auto-
    // show in the user's Valchiria — the user must explicitly pick it
    // via a row in `valchiria_user_picks`.
    const [ownRes, sharedRes, picksRes] = await Promise.all([
      baseSelect.eq('owner_user_id', ctx.userId),
      masterId
        ? supabaseAdmin
            .from('archived_funnels')
            .select(SELECT_COLS)
            .eq('owner_user_id', masterId)
            .eq('share_with_users', true)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null } as { data: unknown[]; error: null }),
      supabaseAdmin
        .from('valchiria_user_picks')
        .select('funnel_id')
        .eq('user_id', ctx.userId),
    ]);

    if (ownRes.error) throw ownRes.error;
    if ('error' in sharedRes && sharedRes.error) throw sharedRes.error;
    // Picks failure shouldn't poison the whole response — fall back to
    // "no picks" so the Valchiria page still works (the user just won't
    // see their shared selections this round).
    const pickedIds = new Set<string>(
      (picksRes.error ? [] : (picksRes.data || [])).map((p: { funnel_id: string }) => p.funnel_id),
    );

    const ownRows: ValchiriaFunnelRow[] = (ownRes.data || []).map((r) => ({
      ...r,
      isShared: false,
      isInMyValchiria: !!r.show_in_valchiria,
    }));
    const sharedRowsRaw = (sharedRes as { data: ValchiriaFunnelRow[] }).data || [];
    const sharedRows: ValchiriaFunnelRow[] = sharedRowsRaw.map((r) => ({
      ...r,
      isShared: true,
      isInMyValchiria: pickedIds.has(r.id),
    }));

    // Sort merged set newest-first across both buckets so the UI shows
    // a single coherent list. We can switch to grouped sections later
    // if the master pushes a lot of library funnels.
    const merged = [...ownRows, ...sharedRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return NextResponse.json({ success: true, funnels: merged });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        funnels: [],
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
