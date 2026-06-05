import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

/**
 * GET /api/api-usage/summary
 *
 * Aggregations the dashboard cares about, in a single round-trip.
 *
 * Multi-tenancy:
 *   - Master (or no-JWT service-role callers): see EVERYONE's spend,
 *     plus a `byUser` breakdown.
 *   - Regular user: see only their own spend; byUser is omitted (it
 *     would be a degenerate one-row table).
 *
 * Done with raw client-side reduction over a single SELECT instead of
 * SQL GROUP BYs because Supabase's PostgREST doesn't expose grouped
 * aggregates without a database function — and a 30-day window is
 * small enough (~thousands of rows even on heavy use) that a single
 * fetch + JS reduce is faster to ship than a Postgres function.
 *
 * If the api_usage_log table doesn't exist yet (migration not applied)
 * we return zeros instead of failing, so the dashboard renders even
 * before the table is set up.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface UsageRow {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  source: string | null;
  agent: string | null;
  duration_ms: number | null;
  owner_user_id: string | null;
}

interface ByUserRow {
  user_id: string | null;
  email: string | null;
  cost_usd: number;
  calls: number;
}

function isoMidnightUtc(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const EMPTY_RESPONSE = {
  totalCostUsd: 0,
  todayCostUsd: 0,
  last7dCostUsd: 0,
  last30dCostUsd: 0,
  byProvider: [] as { provider: string; cost_usd: number; calls: number }[],
  bySource: [] as { source: string; cost_usd: number; calls: number }[],
  byUser: [] as ByUserRow[],
  scope: 'self' as 'all' | 'self',
  recent: [] as UsageRow[],
  warning: null as string | null,
};

export async function GET(req: NextRequest) {
  const ctx = await getUserAccessContext(req);
  // Master OR unauthenticated server-side callers (no JWT) see the
  // whole org. Regular users only see rows tagged with their UUID.
  // Pre-multi-tenancy rows (owner_user_id IS NULL) are visible only
  // to the master / no-JWT branch — a regular user must never see
  // someone else's spend by accident.
  const scope: 'all' | 'self' = ctx.isMaster || !ctx.userId ? 'all' : 'self';

  // 1. All-time total — small projection (one column) so the row
  //    count doesn't matter.
  let totalQuery = supabaseAdmin
    .from('api_usage_log')
    .select('cost_usd');
  if (scope === 'self') totalQuery = totalQuery.eq('owner_user_id', ctx.userId!);
  const { data: totalRow, error: totalErr } = await totalQuery;

  if (totalErr) {
    if (
      totalErr.message?.toLowerCase().includes('relation') ||
      totalErr.message?.toLowerCase().includes('does not exist')
    ) {
      return NextResponse.json({
        ...EMPTY_RESPONSE,
        scope,
        warning:
          "Tabella api_usage_log non trovata. Applica supabase-migration-api-usage-log.sql nel SQL Editor di Supabase per iniziare a tracciare la spesa.",
      });
    }
    return NextResponse.json(
      { ...EMPTY_RESPONSE, scope, warning: `Supabase error: ${totalErr.message}` },
      { status: 200 },
    );
  }

  const totalCostUsd = (totalRow || []).reduce(
    (acc, r) => acc + Number((r as { cost_usd: number }).cost_usd || 0),
    0,
  );

  // 2. Last 30 days for breakdowns + windows. One fetch, then JS-reduced
  //    into all the views the dashboard wants.
  const since30 = isoDaysAgo(30);
  const since7 = isoDaysAgo(7);
  const sinceToday = isoMidnightUtc();

  let rowsQuery = supabaseAdmin
    .from('api_usage_log')
    .select('*')
    .gte('created_at', since30)
    .order('created_at', { ascending: false });
  if (scope === 'self') rowsQuery = rowsQuery.eq('owner_user_id', ctx.userId!);
  const { data: rows30, error: rows30Err } = await rowsQuery;

  if (rows30Err) {
    // owner_user_id missing on the table (e.g. migration not applied
    // yet) — retry without the column filter so the dashboard still
    // renders SOMETHING useful instead of an empty error screen.
    const msg = rows30Err.message?.toLowerCase() || '';
    if (msg.includes('owner_user_id') && msg.includes('does not exist')) {
      return NextResponse.json({
        ...EMPTY_RESPONSE,
        totalCostUsd,
        scope: 'all',
        warning:
          "Colonna owner_user_id non trovata su api_usage_log. Applica supabase-migration-api-usage-owner.sql per abilitare la spesa per utente.",
      });
    }
    return NextResponse.json(
      { ...EMPTY_RESPONSE, totalCostUsd, scope, warning: `Supabase error: ${rows30Err.message}` },
      { status: 200 },
    );
  }

  const rows = (rows30 || []) as unknown as UsageRow[];

  let todayCostUsd = 0;
  let last7dCostUsd = 0;
  let last30dCostUsd = 0;
  const byProviderMap = new Map<string, { cost_usd: number; calls: number }>();
  const bySourceMap = new Map<string, { cost_usd: number; calls: number }>();
  const byUserMap = new Map<string | null, { cost_usd: number; calls: number }>();

  for (const r of rows) {
    const cost = Number(r.cost_usd || 0);
    last30dCostUsd += cost;
    if (r.created_at >= since7) last7dCostUsd += cost;
    if (r.created_at >= sinceToday) todayCostUsd += cost;

    const prov = r.provider || 'unknown';
    const pAcc = byProviderMap.get(prov) || { cost_usd: 0, calls: 0 };
    pAcc.cost_usd += cost;
    pAcc.calls += 1;
    byProviderMap.set(prov, pAcc);

    const src = r.source || '(unknown)';
    const sAcc = bySourceMap.get(src) || { cost_usd: 0, calls: 0 };
    sAcc.cost_usd += cost;
    sAcc.calls += 1;
    bySourceMap.set(src, sAcc);

    if (scope === 'all') {
      const userKey = r.owner_user_id || null;
      const uAcc = byUserMap.get(userKey) || { cost_usd: 0, calls: 0 };
      uAcc.cost_usd += cost;
      uAcc.calls += 1;
      byUserMap.set(userKey, uAcc);
    }
  }

  const byProvider = Array.from(byProviderMap.entries())
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const bySource = Array.from(bySourceMap.entries())
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  // Resolve user emails for the byUser table. Best-effort: if listing
  // users fails we still ship the breakdown with email=null and the
  // UI shows the UUID prefix as a fallback label.
  let byUser: ByUserRow[] = [];
  if (scope === 'all' && byUserMap.size > 0) {
    const userIds = Array.from(byUserMap.keys()).filter((id): id is string => !!id);
    const emailById = new Map<string, string>();
    if (userIds.length > 0) {
      try {
        // Supabase Admin's listUsers paginates at 50/100 per page; for
        // the small set we have here (typically <20 active users) the
        // first page is enough. If the team grows past that we'd need
        // a chunked lookup, but the dashboard cost would suggest it.
        const { data: usersPage } = await supabaseAdmin.auth.admin.listUsers({
          page: 1,
          perPage: 200,
        });
        for (const u of usersPage?.users || []) {
          if (u.id && u.email) emailById.set(u.id, u.email);
        }
      } catch {
        // Auth lookup failure → fall through; UI will show UUID prefix.
      }
    }
    byUser = Array.from(byUserMap.entries())
      .map(([userId, v]) => ({
        user_id: userId,
        email: userId ? emailById.get(userId) || null : null,
        ...v,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);
  }

  const recent = rows.slice(0, 50);

  return NextResponse.json({
    totalCostUsd,
    todayCostUsd,
    last7dCostUsd,
    last30dCostUsd,
    byProvider,
    bySource,
    byUser,
    scope,
    recent,
    warning: null,
  });
}
