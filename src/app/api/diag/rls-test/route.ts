/**
 * Diagnostic endpoint to figure out why multi-tenancy RLS isn't isolating
 * a given user. Hit this while logged in as the suspect user (e.g.
 * `curl https://.../api/diag/rls-test -H "Authorization: Bearer <jwt>"` or
 * just visit it in the browser since the global fetch interceptor adds
 * the header for you).
 *
 * It returns three perspectives on the `funnel_pages` table:
 *
 *   1. `service_role_total`        → total rows in the table (no RLS).
 *   2. `service_role_master_total` → rows owned by the master.
 *   3. `service_role_caller_total` → rows owned by the calling user.
 *   4. `anon_with_jwt_visible`     → rows visible when querying with the
 *                                    caller's JWT (this is what the front
 *                                    end actually sees through RLS).
 *   5. `rls_enabled`               → whether RLS is enabled on the table.
 *   6. `is_master`                 → whether `is_master(caller)` is true.
 *   7. `policies`                  → all SELECT policies on the table.
 *
 * Interpreting the result:
 *
 *   - If `rls_enabled === false` → migration didn't actually flip RLS on,
 *     re-run the relevant ENABLE ROW LEVEL SECURITY statement.
 *   - If `is_master === true` for a "regular" user → their permissions
 *     row says they are master, fix `app_user_permissions`.
 *   - If `service_role_caller_total === 0` and `anon_with_jwt_visible > 0`
 *     → RLS isn't blocking; check the policy expression in `policies`.
 *   - If `anon_with_jwt_visible === 0` and the user STILL sees rows in
 *     the UI → the UI is reading from somewhere else (stale Zustand,
 *     IndexedDB, another endpoint).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'funnel_pages';

export async function GET(req: NextRequest) {
  const ctx = await getUserAccessContext(req);
  if (!ctx.userId) {
    return NextResponse.json({ error: 'no_jwt', message: 'No user JWT detected in request' }, { status: 401 });
  }
  // Master-only: this endpoint leaks the master_id and per-table row
  // counts. Useful for debug but not for regular users.
  if (!ctx.isMaster) {
    return NextResponse.json({ error: 'forbidden', message: 'Master only' }, { status: 403 });
  }
  const callerUserId = ctx.userId;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Extract the raw JWT from the request so we can replay the *exact*
  // same auth context against PostgREST.
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const out: Record<string, unknown> = {
    caller_user_id: callerUserId,
    table: TABLE,
  };

  // 1. Caller permissions row (role + sections).
  try {
    const { data: perms } = await supabaseAdmin
      .from('app_user_permissions')
      .select('role, sections')
      .eq('user_id', callerUserId)
      .maybeSingle();
    out.caller_permissions = perms || null;
  } catch (e) {
    out.caller_permissions = { error: (e as Error).message };
  }

  // 2. Service-role totals (bypasses RLS — ground truth).
  try {
    const { count: total } = await supabaseAdmin
      .from(TABLE)
      .select('id', { count: 'exact', head: true });
    out.service_role_total = total ?? 0;

    const { data: masterIdRow } = await supabaseAdmin.rpc('get_master_id');
    out.master_id = masterIdRow;

    if (masterIdRow) {
      const { count: masterTotal } = await supabaseAdmin
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', masterIdRow);
      out.service_role_master_total = masterTotal ?? 0;
    }

    const { count: callerTotal } = await supabaseAdmin
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', callerUserId);
    out.service_role_caller_total = callerTotal ?? 0;
  } catch (e) {
    out.service_role_error = (e as Error).message;
  }

  // 3. is_master(callerUserId) — what RLS will see.
  try {
    const { data, error } = await supabaseAdmin.rpc('is_master', { uid: callerUserId });
    out.is_master_for_caller = error ? `ERR: ${error.message}` : data;
  } catch (e) {
    out.is_master_for_caller = `THREW: ${(e as Error).message}`;
  }

  // 4. RLS-enabled status + policy expressions for the table.
  try {
    const { data: tblInfo, error } = await supabaseAdmin
      .from('pg_tables')
      .select('rowsecurity')
      .eq('schemaname', 'public')
      .eq('tablename', TABLE)
      .maybeSingle();
    out.rls_enabled = error ? `ERR: ${error.message}` : (tblInfo as { rowsecurity?: boolean } | null)?.rowsecurity;
  } catch (e) {
    out.rls_enabled = `THREW: ${(e as Error).message}`;
  }

  // 5. The thing we actually care about: how many rows are visible to
  //    the caller through PostgREST (i.e. with RLS applied)?
  if (jwt) {
    try {
      const anonClient = createClient(url, anon, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { count, error } = await anonClient
        .from(TABLE)
        .select('id', { count: 'exact', head: true });
      out.anon_with_jwt_visible = error ? `ERR: ${error.message}` : (count ?? 0);

      // Sample a few rows so we can see WHO owns them.
      const { data: sample, error: sErr } = await anonClient
        .from(TABLE)
        .select('id, owner_user_id, created_at')
        .limit(5);
      out.anon_with_jwt_sample = sErr ? `ERR: ${sErr.message}` : sample;
    } catch (e) {
      out.anon_with_jwt_visible = `THREW: ${(e as Error).message}`;
    }
  } else {
    out.anon_with_jwt_visible = 'NO_JWT_IN_REQUEST';
  }

  return NextResponse.json(out);
}
