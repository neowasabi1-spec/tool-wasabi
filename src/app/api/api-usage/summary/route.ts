import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * GET /api/api-usage/summary
 *
 * Aggregations the dashboard cares about, in a single round-trip:
 *   - totalCostUsd:       all-time
 *   - todayCostUsd:       since 00:00 user-local (we use UTC midnight,
 *                         close enough — refining to TZ would need a query
 *                         param the dashboard doesn't have today)
 *   - last7dCostUsd:      rolling 7-day window
 *   - last30dCostUsd:     rolling 30-day window
 *   - byProvider:         [{ provider, cost_usd, calls }]   (last 30d)
 *   - bySource:           [{ source,   cost_usd, calls }]   (last 30d)
 *   - recent:             last 50 rows for the activity table
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
  recent: [] as UsageRow[],
  warning: null as string | null,
};

export async function GET(_req: NextRequest) {
  // 1. All-time total — small projection (one column) so the row
  //    count doesn't matter.
  const { data: totalRow, error: totalErr } = await supabase
    .from('api_usage_log')
    .select('cost_usd');

  if (totalErr) {
    if (
      totalErr.message?.toLowerCase().includes('relation') ||
      totalErr.message?.toLowerCase().includes('does not exist')
    ) {
      return NextResponse.json({
        ...EMPTY_RESPONSE,
        warning:
          "Tabella api_usage_log non trovata. Applica supabase-migration-api-usage-log.sql nel SQL Editor di Supabase per iniziare a tracciare la spesa.",
      });
    }
    return NextResponse.json(
      { ...EMPTY_RESPONSE, warning: `Supabase error: ${totalErr.message}` },
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

  const { data: rows30, error: rows30Err } = await supabase
    .from('api_usage_log')
    .select('*')
    .gte('created_at', since30)
    .order('created_at', { ascending: false });

  if (rows30Err) {
    return NextResponse.json(
      { ...EMPTY_RESPONSE, totalCostUsd, warning: `Supabase error: ${rows30Err.message}` },
      { status: 200 },
    );
  }

  const rows = (rows30 || []) as unknown as UsageRow[];

  let todayCostUsd = 0;
  let last7dCostUsd = 0;
  let last30dCostUsd = 0;
  const byProviderMap = new Map<string, { cost_usd: number; calls: number }>();
  const bySourceMap = new Map<string, { cost_usd: number; calls: number }>();

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
  }

  const byProvider = Array.from(byProviderMap.entries())
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const bySource = Array.from(bySourceMap.entries())
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const recent = rows.slice(0, 50);

  return NextResponse.json({
    totalCostUsd,
    todayCostUsd,
    last7dCostUsd,
    last30dCostUsd,
    byProvider,
    bySource,
    recent,
    warning: null,
  });
}
