/**
 * GET /api/valchiria/funnels/:id/steps
 *
 * Lightweight step list for the Chimera picker. The shared funnels index
 * often returns total_steps without the actual step rows (HTML-heavy walks
 * time out). Regular users hit that empty list; this endpoint loads one
 * funnel's names/types on demand.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { pickerStepsFromArchive } from '@/lib/archive-placement';
import { loadFunnelStepShells } from '@/lib/slim-archived-funnels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 20;

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const ctx = await getUserAccessContext(req);
  if (!ctx.userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = params.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  try {
    const raw = await loadFunnelStepShells(id);
    const steps = pickerStepsFromArchive(raw);
    return NextResponse.json({ success: true, steps });
  } catch (e) {
    return NextResponse.json(
      { success: false, steps: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
