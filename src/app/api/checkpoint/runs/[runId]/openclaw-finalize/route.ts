import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { syncLastRunSnapshot } from '@/lib/checkpoint-store';
import type {
  CheckpointResults,
  CheckpointRunStatus,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/checkpoint/runs/[runId]/openclaw-finalize
 *
 * Body: { status?: 'completed'|'partial'|'failed', error?: string }
 *
 * Closes a run that was started with `auditor: 'openclaw:*'`. The
 * worker calls this once after all category prompts have streamed
 * through `/openclaw-category`. We:
 *
 *   1. Recompute the overall score from whatever category scores
 *      ended up being persisted (server-side, never trust the worker
 *      with the final number).
 *   2. Stamp completed_at + status.
 *   3. Sync the parent funnel's "last run" denormalised snapshot.
 *
 * If the worker's `status` disagrees with what we see on disk
 * (e.g. it says 'completed' but no category was ever saved) we
 * downgrade to 'failed' with a clear error message, so the UI never
 * shows "completed" with empty results.
 */
const ALLOWED_STATUSES: CheckpointRunStatus[] = [
  'completed',
  'partial',
  'failed',
];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }

  let body: { status?: string; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const { data: row, error: readErr } = await supabase
    .from('funnel_checkpoints')
    .select('id, checkpoint_funnel_id, results, status')
    .eq('id', runId)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json(
      { error: 'Run not found', detail: readErr?.message },
      { status: 404 },
    );
  }

  const results: CheckpointResults = (row.results as CheckpointResults) ?? {};
  const numericScores = Object.values(results)
    .map((r) => r?.score)
    .filter((s): s is number => typeof s === 'number');
  const overall =
    numericScores.length > 0
      ? Math.round(
          numericScores.reduce((a, b) => a + b, 0) / numericScores.length,
        )
      : null;

  const reportedStatus = body.status as CheckpointRunStatus | undefined;
  const everSaved = Object.keys(results).length;
  let finalStatus: CheckpointRunStatus;
  if (everSaved === 0) {
    finalStatus = 'failed';
  } else if (reportedStatus && ALLOWED_STATUSES.includes(reportedStatus)) {
    finalStatus = reportedStatus;
  } else {
    finalStatus = 'completed';
  }

  const completedAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: finalStatus,
    score_overall: overall,
    completed_at: completedAt,
  };
  if (finalStatus === 'failed') {
    update.error =
      body.error ??
      (everSaved === 0
        ? 'OpenClaw worker finalised the run with zero category results.'
        : 'OpenClaw worker reported failure.');
  }

  const { error: updErr } = await supabase
    .from('funnel_checkpoints')
    .update(update)
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
    scoreOverall: overall,
    status: finalStatus,
    ranAt: completedAt,
  });

  return NextResponse.json({
    ok: true,
    runId,
    status: finalStatus,
    score_overall: overall,
    categoryCount: everSaved,
  });
}
