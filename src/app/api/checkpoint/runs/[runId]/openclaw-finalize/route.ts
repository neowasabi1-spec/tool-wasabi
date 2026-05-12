import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { syncLastRunSnapshot } from '@/lib/checkpoint-store';
import type {
  CheckpointCategory,
  CheckpointCategoryResult,
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

  let body: {
    status?: string;
    error?: string;
    /** Categories the worker actually attempted (i.e. were returned
     *  by /openclaw-prep as runnable). The finaliser uses this list
     *  to detect "lost" categories — ones the worker never reported
     *  back via /openclaw-category — and persist them as `error` so
     *  the dashboard never shows "In attesa di analisi" on a run
     *  that's been marked completed. */
    expectedCategories?: string[];
  };
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

  // Fill any expected category that NEVER reported back from the
  // worker. The dashboard polls `results.<category>` to decide
  // whether a column is "in attesa" / "completata" / "errore"; if
  // the worker dies mid-loop or one of its POSTs to
  // /openclaw-category times out silently, the column is stuck on
  // "In attesa di analisi…" forever — even on a run flagged as
  // completed. Materialising those gaps as explicit `error` rows
  // restores observable feedback.
  const expectedCategories = Array.isArray(body.expectedCategories)
    ? (body.expectedCategories.filter(
        (c): c is CheckpointCategory => typeof c === 'string',
      ) as CheckpointCategory[])
    : [];
  let lost = 0;
  for (const cat of expectedCategories) {
    if (results[cat]) continue;
    const lostResult: CheckpointCategoryResult = {
      score: null,
      status: 'error',
      summary:
        "Il worker OpenClaw non ha riportato il risultato per questa categoria (timeout o crash mid-loop). Riprova la run.",
      issues: [],
      suggestions: [],
      error:
        'Worker did not POST /openclaw-category for this category before finalising.',
    };
    results[cat] = lostResult;
    lost++;
  }

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
  // Recompute the run status from observable per-category state,
  // not from whatever the worker self-reported. This way
  // "completed" can never coexist with categories silently missing.
  const categoryStatuses = Object.values(results).map((r) => r?.status);
  const okCount = categoryStatuses.filter(
    (s) => s === 'pass' || s === 'warn' || s === 'fail',
  ).length;
  const errorCount = categoryStatuses.filter((s) => s === 'error').length;
  let finalStatus: CheckpointRunStatus;
  if (everSaved === 0) {
    finalStatus = 'failed';
  } else if (okCount === 0) {
    finalStatus = 'failed';
  } else if (errorCount > 0) {
    finalStatus = 'partial';
  } else if (reportedStatus && ALLOWED_STATUSES.includes(reportedStatus)) {
    // No errors observed — trust the worker's self-report (it might
    // legitimately downgrade to 'partial' for skipped categories).
    finalStatus = reportedStatus;
  } else {
    finalStatus = 'completed';
  }

  const completedAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: finalStatus,
    score_overall: overall,
    completed_at: completedAt,
    // Persist the patched results so any "lost" categories filled
    // above survive the row update.
    results,
  };
  if (finalStatus === 'failed') {
    update.error =
      body.error ??
      (everSaved === 0
        ? 'OpenClaw worker finalised the run with zero category results.'
        : 'OpenClaw worker reported failure.');
  } else if (lost > 0) {
    // Soft signal in the run-level error column so the dashboard's
    // run header can warn the user about the partial outcome.
    update.error = `${lost} categoria/e non riportata/e dal worker (timeout o crash). Risultati parziali.`;
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
    lostCategories: lost,
    score_overall: overall,
    categoryCount: everSaved,
  });
}
