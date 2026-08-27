/**
 * TEMPORARY — regroup recovered archive pages into walk folders using
 * save-time bursts (funnel walks save steps seconds apart). Token-guarded.
 * REMOVE after use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const TOKEN = 'wsb-diag-8f3a1c6e2b';
const GAP_MS = 5 * 60 * 1000; // max gap between consecutive steps of one walk

interface Row {
  id: string;
  name: string;
  steps: Array<Record<string, unknown>>;
  created_at: string;
  owner_user_id: string | null;
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const dry = req.nextUrl.searchParams.get('dry') === '1';

  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, created_at, owner_user_id')
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Only recovered single-step rows not already renamed into a walk folder.
  const candidates = ((data || []) as Row[]).filter((r) => {
    const s = Array.isArray(r.steps) ? r.steps[0] : null;
    const cd = (s?.cloned_data || {}) as Record<string, unknown>;
    return (
      Array.isArray(r.steps) &&
      r.steps.length === 1 &&
      cd.method_used === 'rebuild-from-page-html' &&
      !/—\s*Step\s+\d+$/i.test(r.name)
    );
  });

  // Split into bursts: same owner, consecutive saves ≤ GAP_MS apart.
  const byOwner = new Map<string, Row[]>();
  for (const r of candidates) {
    const k = r.owner_user_id || 'null';
    byOwner.set(k, [...(byOwner.get(k) || []), r]);
  }

  const sessions: Row[][] = [];
  byOwner.forEach((rows) => {
    let cur: Row[] = [];
    let lastTs = 0;
    for (const r of rows) {
      const ts = new Date(r.created_at).getTime();
      if (cur.length && ts - lastTs > GAP_MS) {
        if (cur.length >= 2) sessions.push(cur);
        cur = [];
      }
      cur.push(r);
      lastTs = ts;
    }
    if (cur.length >= 2) sessions.push(cur);
  });

  // Label each session: most common domain among members, else shortest title.
  const usedLabels = new Set<string>();
  const plan: Array<{ label: string; ids: string[]; names: string[] }> = [];
  for (const session of sessions) {
    const domains = new Map<string, number>();
    for (const r of session) {
      const s = r.steps[0] as { url_to_swipe?: string };
      try {
        const d = s?.url_to_swipe ? new URL(s.url_to_swipe).hostname.replace(/^www\./, '') : '';
        if (d) domains.set(d, (domains.get(d) || 0) + 1);
      } catch { /* no url */ }
    }
    let label =
      [...domains.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
      [...session].map((r) => r.name).sort((a, b) => a.length - b.length)[0] ||
      'Recovered funnel';
    label = label.slice(0, 90);
    let unique = label;
    let n = 2;
    while (usedLabels.has(unique)) unique = `${label} (${n++})`;
    usedLabels.add(unique);
    plan.push({ label: unique, ids: session.map((r) => r.id), names: session.map((r) => r.name) });
  }

  let renamed = 0;
  const errors: string[] = [];
  if (!dry) {
    for (const g of plan) {
      for (let i = 0; i < g.ids.length; i++) {
        const newName = `${g.label} — Step ${i + 1}`;
        const row = candidates.find((r) => r.id === g.ids[i])!;
        const steps = row.steps.map((s) => ({ ...s, name: newName }));
        const { error: uErr } = await supabaseAdmin
          .from('archived_funnels')
          .update({ name: newName, steps })
          .eq('id', g.ids[i]);
        if (uErr) errors.push(`${g.ids[i]}: ${uErr.message}`);
        else renamed++;
      }
    }
  }

  return NextResponse.json({
    dry,
    candidates: candidates.length,
    sessions: plan.length,
    renamed,
    errors,
    plan: plan.map((g) => ({ label: g.label, steps: g.ids.length, sample: g.names.slice(0, 3) })),
  });
}
