import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractJsonFromReply } from '@/lib/checkpoint-prompts';
import type {
  CheckpointCategory,
  CheckpointCategoryResult,
  CheckpointResults,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/checkpoint/runs/[runId]/openclaw-category
 *
 * Body:
 *   { category, ok: true,  reply: string }   // happy path
 *   { category, ok: false, error: string }   // category-level failure
 *
 * Called by the OpenClaw worker after each category audit, to stream
 * partial results into the live dashboard. The worker only ships the
 * raw model reply — we parse + normalise it server-side so the same
 * validation runs whether the audit was done by Claude or OpenClaw.
 */
const SCORE_COL: Record<CheckpointCategory, string> = {
  navigation: 'score_navigation',
  coherence: 'score_coherence',
  copy: 'score_copy',
  cro: 'score_cro',
  tov: 'score_tov',
  compliance: 'score_compliance',
};

const VALID_CATEGORIES: CheckpointCategory[] = [
  'navigation',
  'coherence',
  'copy',
  'cro',
  'tov',
  'compliance',
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
    category?: string;
    ok?: boolean;
    reply?: string;
    error?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body JSON non valido.' }, { status: 400 });
  }

  const cat = body.category as CheckpointCategory;
  if (!cat || !VALID_CATEGORIES.includes(cat)) {
    return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
  }

  // Build the per-category result. Errors come pre-flagged from the
  // worker; happy-path replies still need JSON parsing + normalisation.
  let result: CheckpointCategoryResult;
  if (body.ok === false) {
    result = {
      score: null,
      status: 'error',
      summary: 'Audit failed on the OpenClaw worker.',
      issues: [],
      suggestions: [],
      error: body.error ?? 'Unknown worker error.',
    };
  } else {
    const reply = String(body.reply ?? '');
    try {
      const parsed = extractJsonFromReply(reply);
      result = normaliseCategoryResult(parsed, reply);
    } catch (err) {
      result = {
        score: null,
        status: 'error',
        summary: 'OpenClaw returned non-JSON reply.',
        issues: [],
        suggestions: [],
        rawReply: reply.slice(0, 4000),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Read-modify-write the JSONB results column. Race-safe enough for
  // our 1-job-at-a-time worker; if we ever parallelise we'll need
  // jsonb_set RPCs.
  const { data: existing, error: readErr } = await supabase
    .from('funnel_checkpoints')
    .select('results')
    .eq('id', runId)
    .maybeSingle();
  if (readErr || !existing) {
    return NextResponse.json(
      { error: 'Run not found', detail: readErr?.message },
      { status: 404 },
    );
  }
  const merged: CheckpointResults = {
    ...((existing.results as CheckpointResults) ?? {}),
    [cat]: result,
  };

  const update: Record<string, unknown> = {
    results: merged,
    [SCORE_COL[cat]]: result.score ?? null,
  };
  const { error: updErr } = await supabase
    .from('funnel_checkpoints')
    .update(update)
    .eq('id', runId);
  if (updErr) {
    return NextResponse.json(
      { error: 'Failed to update run', detail: updErr.message },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    category: cat,
    score: result.score,
    status: result.status,
  });
}

function normaliseCategoryResult(
  parsed: unknown,
  rawReply: string,
): CheckpointCategoryResult {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rawScore = obj.score;
  const score =
    typeof rawScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : null;
  const summary =
    typeof obj.summary === 'string' ? obj.summary : 'No summary provided.';
  const issues = Array.isArray(obj.issues)
    ? (obj.issues as Record<string, unknown>[])
        .filter((it) => it && typeof it.title === 'string')
        .map((it) => ({
          severity:
            it.severity === 'critical' || it.severity === 'warning'
              ? (it.severity as 'critical' | 'warning')
              : ('info' as const),
          title: String(it.title).slice(0, 200),
          detail:
            typeof it.detail === 'string' ? it.detail.slice(0, 1500) : undefined,
          evidence:
            typeof it.evidence === 'string'
              ? it.evidence.slice(0, 600)
              : undefined,
        }))
    : [];
  const suggestions = Array.isArray(obj.suggestions)
    ? (obj.suggestions as Record<string, unknown>[])
        .filter((it) => it && typeof it.title === 'string')
        .map((it) => ({
          title: String(it.title).slice(0, 200),
          detail:
            typeof it.detail === 'string' ? it.detail.slice(0, 1500) : undefined,
        }))
    : [];

  let status: CheckpointCategoryResult['status'];
  if (score === null) status = 'warn';
  else if (score >= 80) status = 'pass';
  else if (score >= 50) status = 'warn';
  else status = 'fail';

  return {
    score,
    status,
    summary,
    issues,
    suggestions,
    rawReply: rawReply.slice(0, 4000),
  };
}
