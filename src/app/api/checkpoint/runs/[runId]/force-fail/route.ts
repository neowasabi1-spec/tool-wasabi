import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { syncLastRunSnapshot } from '@/lib/checkpoint-store';
import type { CheckpointRunStatus } from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/checkpoint/runs/[runId]/force-fail
 *
 * Body: { reason?: string }
 *
 * Manually mark a run as `failed`. Used by the dashboard when the
 * client has been polling a `running` row for too long without seeing
 * any progress (worker died mid-job, openclaw-prep crashed and the
 * worker couldn't even call openclaw-finalize, the user closed their
 * laptop while the worker was processing, etc).
 *
 * Without this endpoint, an orphaned `running` row hangs forever and
 * the UI badge stays stuck on "in corso (in background)".
 *
 * Idempotent: a no-op for runs already in a terminal status, so it's
 * safe to wire to a UI button that the user might click twice.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }

  let body: { reason?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 500)
      : 'Run forzata come fallita dall\'utente (worker non risponde o run bloccata).';

  // Read first so we can no-op terminal runs and so we know the
  // funnel id for syncLastRunSnapshot.
  const { data: row, error: readErr } = await supabase
    .from('funnel_checkpoints')
    .select('id, checkpoint_funnel_id, status, results')
    .eq('id', runId)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json(
      { error: 'Run not found', detail: readErr?.message },
      { status: 404 },
    );
  }

  // Already terminal — return current state without touching it.
  if (
    row.status === 'completed' ||
    row.status === 'partial' ||
    row.status === 'failed'
  ) {
    return NextResponse.json({
      ok: true,
      runId,
      status: row.status as CheckpointRunStatus,
      noop: true,
      message: `Run is already in a terminal status (${row.status}); nothing to do.`,
    });
  }

  const completedAt = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('funnel_checkpoints')
    .update({
      status: 'failed' as CheckpointRunStatus,
      error: reason,
      completed_at: completedAt,
    })
    .eq('id', runId);
  if (updErr) {
    return NextResponse.json(
      { error: 'Could not update run', detail: updErr.message },
      { status: 500 },
    );
  }

  await syncLastRunSnapshot({
    funnelId: row.checkpoint_funnel_id as string,
    runId,
    scoreOverall: null,
    status: 'failed',
    ranAt: completedAt,
  });

  return NextResponse.json({
    ok: true,
    runId,
    status: 'failed' as CheckpointRunStatus,
    completed_at: completedAt,
    reason,
  });
}
