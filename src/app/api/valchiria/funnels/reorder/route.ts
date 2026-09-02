/**
 * POST /api/valchiria/funnels/reorder
 *
 * Manual reordering of funnel-walk steps in Templates.
 *
 * The browser extension's funnel walk saves every captured page as its OWN
 * single-step `archived_funnels` row named "<domain> — Step N", and the
 * Templates page folds those siblings into one folder sorted by the parsed
 * step number. Reordering therefore means RENUMBERING the rows: we rewrite
 * the "Step N" suffix in the row name (and mirror it into steps[0]) for
 * every member of the folder.
 *
 * Body: { renames: [{ id: string, step: number }, ...] }
 *   — one entry per folder member, with the desired 1-based step number.
 *
 * Owner (or master) only, checked per row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

interface RenameEntry {
  id: string;
  step: number;
}

const STEP_SUFFIX_RE = /Step\s+\d+\s*$/i;

function renumberName(name: string, step: number): string {
  if (STEP_SUFFIX_RE.test(name)) return name.replace(STEP_SUFFIX_RE, `Step ${step}`);
  return `${name} — Step ${step}`;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getUserAccessContext(req);
    if (!ctx.userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { renames?: RenameEntry[] };
    const renames = Array.isArray(body.renames) ? body.renames : [];
    if (
      renames.length === 0 ||
      renames.some((r) => !r || typeof r.id !== 'string' || !Number.isInteger(r.step) || r.step < 1)
    ) {
      return NextResponse.json(
        { error: 'invalid_body', message: 'Expected { renames: [{ id, step }] } with 1-based integer steps' },
        { status: 400 },
      );
    }

    const ids = renames.map((r) => r.id);
    const { data: rows, error: lookupErr } = await supabaseAdmin
      .from('archived_funnels')
      .select('id, name, owner_user_id, steps')
      .in('id', ids);
    if (lookupErr) throw lookupErr;

    const byId = new Map((rows || []).map((r) => [r.id, r]));
    for (const { id } of renames) {
      const row = byId.get(id);
      if (!row) return NextResponse.json({ error: 'not_found', id }, { status: 404 });
      // Shared Templates library: any logged-in user may reorder.
    }

    for (const { id, step } of renames) {
      const row = byId.get(id)!;
      const newName = renumberName(String(row.name || ''), step);

      // Mirror the number into the row's single step so any consumer that
      // reads step_index / step name stays coherent with the new order.
      const steps = Array.isArray(row.steps) ? (row.steps as Array<Record<string, unknown>>) : [];
      const newSteps = steps.map((s, i) => {
        if (i !== 0) return s;
        const out: Record<string, unknown> = { ...s, step_index: step };
        if (typeof out.name === 'string' && STEP_SUFFIX_RE.test(out.name as string)) {
          out.name = (out.name as string).replace(STEP_SUFFIX_RE, `Step ${step}`);
        }
        return out;
      });

      const { error: updErr } = await supabaseAdmin
        .from('archived_funnels')
        .update({ name: newName, ...(newSteps.length ? { steps: newSteps } : {}) })
        .eq('id', id);
      if (updErr) throw updErr;
    }

    return NextResponse.json({ success: true, renamed: renames.length });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
