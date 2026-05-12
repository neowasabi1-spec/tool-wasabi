import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getFunnel, syncLastRunSnapshot } from '@/lib/checkpoint-store';
import {
  CHECKPOINT_RUN_CATEGORIES,
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointResults,
  type CheckpointRunStatus,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/checkpoint/[id]/runs
 *
 * Body:
 *   {
 *     results: CheckpointResults,         // per-category audit output
 *     status?: CheckpointRunStatus,        // default 'completed'
 *     triggeredByName?: string,
 *     triggeredByUserId?: string,
 *     error?: string,                      // surface only when status='failed'
 *   }
 *
 * Lets an EXTERNAL auditor (eg. OpenClaw via MCP) write a finished
 * run back into funnel_checkpoints, so it shows up in the Checkpoint
 * dashboard exactly like a Claude-powered run.
 *
 * The score columns + score_overall are recomputed server-side from
 * `results` so callers can't cook the numbers; they only ship the
 * per-category payload (score / status / summary / issues / suggestions).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  let body: {
    results?: CheckpointResults;
    status?: CheckpointRunStatus;
    triggeredByName?: string;
    triggeredByUserId?: string;
    error?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }

  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }

  const results: CheckpointResults = (body.results ?? {}) as CheckpointResults;
  const status: CheckpointRunStatus = body.status ?? 'completed';

  // Trust nothing: re-compute overall + per-category score columns
  // from the supplied `results` payload.
  const scoreCol: Record<CheckpointCategory, string> = {
    navigation: 'score_navigation',
    coherence: 'score_coherence',
    copy: 'score_copy',
    cro: 'score_cro',
    tov: 'score_tov',
    compliance: 'score_compliance',
  };
  const scoreColumns: Record<string, number | null> = {};
  for (const cat of [
    ...CHECKPOINT_RUN_CATEGORIES,
    'cro',
    'tov',
    'compliance',
  ] as CheckpointCategory[]) {
    const r = results[cat] as CheckpointCategoryResult | undefined;
    scoreColumns[scoreCol[cat]] =
      typeof r?.score === 'number'
        ? Math.max(0, Math.min(100, Math.round(r.score)))
        : null;
  }
  const numericScores = Object.values(scoreColumns).filter(
    (s): s is number => typeof s === 'number',
  );
  const overall =
    numericScores.length > 0
      ? Math.round(
          numericScores.reduce((a, b) => a + b, 0) / numericScores.length,
        )
      : null;

  const completedAt = new Date().toISOString();
  const triggeredByName =
    (body.triggeredByName ?? '').trim().slice(0, 120) || null;
  const triggeredByUserId = body.triggeredByUserId?.trim() || null;

  const { data, error } = await supabase
    .from('funnel_checkpoints')
    .insert({
      checkpoint_funnel_id: funnel.id,
      funnel_name: funnel.name,
      funnel_url: funnel.url,
      status,
      error: status === 'failed' ? body.error ?? 'Reported as failed by external auditor.' : null,
      results,
      score_overall: overall,
      ...scoreColumns,
      triggered_by_name: triggeredByName,
      triggered_by_user_id: triggeredByUserId,
      completed_at: completedAt,
    })
    .select('id')
    .single();

  if (error || !data) {
    const msg = error?.message ?? 'Insert returned no row';
    return NextResponse.json(
      { error: 'Could not save run', detail: msg },
      { status: 500 },
    );
  }

  await syncLastRunSnapshot({
    funnelId: funnel.id,
    runId: data.id as string,
    scoreOverall: overall,
    status,
    ranAt: completedAt,
  });

  return NextResponse.json(
    {
      runId: data.id,
      status,
      score_overall: overall,
      scores: scoreColumns,
    },
    { status: 201 },
  );
}
