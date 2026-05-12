import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  callClaudeWithKnowledge,
  summarizeUsage,
} from '@/lib/anthropic-with-knowledge';
import {
  getFunnel,
  fetchFunnelPagesHtml,
  syncLastRunSnapshot,
  type FunnelPageHtml,
} from '@/lib/checkpoint-store';
import {
  CATEGORY_PROMPT_CONFIG,
  buildMultiPageUserMessage,
  htmlToAuditText,
  extractJsonFromReply,
  type MultiPagePromptStep,
} from '@/lib/checkpoint-prompts';
import {
  CHECKPOINT_RUN_CATEGORIES,
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointResults,
  type CheckpointRunStatus,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // multi-page Playwright fetch + Claude calls

/**
 * POST /api/checkpoint/[id]/run
 *
 * v2: the funnel is a SEQUENCE of pages. We fetch all of them once
 * (HTML for navigation + audit text for AI), then for each category
 * we ship the entire ordered sequence to Claude.
 *
 * Categories run by default: navigation, coherence, copy.
 * Legacy categories (cro / tov / compliance) are intentionally NOT
 * in the default list — pass them explicitly in `body.categories` if
 * the caller still wants them.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }
  if (!funnel.pages || funnel.pages.length === 0) {
    return NextResponse.json(
      { error: 'Funnel has no pages configured.' },
      { status: 422 },
    );
  }

  let body: {
    categories?: CheckpointCategory[];
    brandProfile?: string;
    productType?: 'supplement' | 'digital' | 'both';
    triggeredByName?: string;
    triggeredByUserId?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // Default = the v2 three-step list. Caller can still opt into the
  // legacy categories by listing them explicitly.
  const categories: CheckpointCategory[] =
    body.categories && body.categories.length > 0
      ? body.categories
      : [...CHECKPOINT_RUN_CATEGORIES];
  const brandProfile = body.brandProfile ?? funnel.brand_profile ?? undefined;
  const triggeredByName = (body.triggeredByName ?? '').trim().slice(0, 120) || null;
  const triggeredByUserId = body.triggeredByUserId?.trim() || null;

  // Open the row FIRST so polling can pick up the runId immediately.
  const { data: insertedRow, error: insertErr } = await supabase
    .from('funnel_checkpoints')
    .insert({
      checkpoint_funnel_id: funnel.id,
      funnel_name: funnel.name,
      funnel_url: funnel.url,
      status: 'running' as CheckpointRunStatus,
      triggered_by_name: triggeredByName,
      triggered_by_user_id: triggeredByUserId,
    })
    .select('id')
    .single();

  if (insertErr || !insertedRow) {
    const msg = insertErr?.message ?? 'Insert returned no row';
    console.error('[checkpoint/run] insert failed:', msg);
    return NextResponse.json(
      { error: 'Could not open checkpoint row', detail: msg },
      { status: 500 },
    );
  }
  const checkpointId = insertedRow.id as string;

  console.log(
    `[checkpoint/run] start runId=${checkpointId} funnel="${funnel.name}" pages=${funnel.pages.length} categories=${categories.join(',')}`,
  );

  // Fetch HTML for ALL pages, in order, AFTER opening the row. If
  // every page fails we close the row as failed; if at least one
  // succeeded we keep going (the AI prompts are designed to surface
  // [FETCH-ERROR] pages as missing).
  const pagesHtml = await fetchFunnelPagesHtml(funnel.pages);
  const reachable = pagesHtml.filter((p) => p.html && p.html.length > 0);
  if (reachable.length === 0) {
    const msg =
      "Nessuna pagina del funnel è stata scaricata. URL irraggiungibili o tutte le risposte vuote.";
    await supabase
      .from('funnel_checkpoints')
      .update({
        status: 'failed' as CheckpointRunStatus,
        error: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', checkpointId);
    return NextResponse.json(
      {
        runId: checkpointId,
        error: msg,
        pages: pagesHtml.map((p) => ({
          index: p.index,
          url: p.url,
          ok: false,
          error: p.error,
        })),
      },
      { status: 422 },
    );
  }

  // Convert each fetched HTML into the compact audit text once, so
  // every category reuses the same input (saves on htmlToAuditText
  // cost when categories > 1).
  const auditSteps: MultiPagePromptStep[] = pagesHtml.map((p) => ({
    index: p.index + 1,
    url: p.url,
    name: p.name,
    pageText: p.html ? htmlToAuditText(p.html) : '',
    fetchError: p.error ?? null,
  }));

  const results: CheckpointResults = {};
  let errored = 0;
  let succeeded = 0;
  const total = categories.length;

  for (let i = 0; i < total; i++) {
    const cat = categories[i];
    const tStart = Date.now();
    console.log(`[checkpoint/run] ▶ ${cat} (${i + 1}/${total})`);

    try {
      // Navigation requires >= 2 reachable pages — record a clean
      // "skipped" with a clear reason instead of running the prompt
      // and hoping the model bails out on its own.
      if (cat === 'navigation' && reachable.length < 2) {
        results[cat] = {
          score: null,
          status: 'skipped',
          summary:
            "Il check Navigazione richiede almeno 2 pagine raggiungibili nel funnel.",
          issues: [],
          suggestions: [],
        };
      } else {
        results[cat] = await runClaudeCategory({
          category: cat,
          funnelName: funnel.name,
          steps: auditSteps,
          brandProfile,
        });
      }
      const status = results[cat]?.status;
      if (status === 'error') errored++;
      else if (status !== 'skipped') succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[checkpoint/run] ✗ ${cat} crashed:`, msg);
      results[cat] = {
        score: null,
        status: 'error',
        summary: `Audit failed: ${msg}`,
        issues: [],
        suggestions: [],
        error: msg,
      };
      errored++;
    }

    const elapsed = Date.now() - tStart;
    console.log(
      `[checkpoint/run] ◀ ${cat} done in ${elapsed}ms · score=${results[cat]?.score ?? 'null'} · status=${results[cat]?.status}`,
    );

    await persistCategory(checkpointId, results, cat);
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
  const finalStatus: CheckpointRunStatus =
    succeeded === 0 ? 'failed' : errored === 0 ? 'completed' : 'partial';
  const completedAt = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('funnel_checkpoints')
    .update({
      score_overall: overall,
      status: finalStatus,
      completed_at: completedAt,
    })
    .eq('id', checkpointId);
  if (updErr) {
    console.error('[checkpoint/run] final update failed:', updErr.message);
  }

  await syncLastRunSnapshot({
    funnelId: funnel.id,
    runId: checkpointId,
    scoreOverall: overall,
    status: finalStatus,
    ranAt: completedAt,
  });

  console.log(
    `[checkpoint/run] ✔ done runId=${checkpointId} status=${finalStatus} overall=${overall} succeeded=${succeeded} errored=${errored}`,
  );

  return NextResponse.json({
    runId: checkpointId,
    status: finalStatus,
    score_overall: overall,
    results,
    pages: pagesHtml.map((p: FunnelPageHtml) => ({
      index: p.index,
      url: p.url,
      ok: !!p.html,
      htmlLength: p.htmlLength,
      error: p.error,
    })),
  });
}

/**
 * Persist a single category's result + its dedicated score column.
 * The JSONB is replaced wholesale (Supabase JS doesn't expose a
 * jsonb_set helper) which is fine for our payload size.
 */
async function persistCategory(
  checkpointId: string,
  results: CheckpointResults,
  cat: CheckpointCategory,
): Promise<void> {
  const scoreCol: Record<CheckpointCategory, string> = {
    navigation: 'score_navigation',
    coherence: 'score_coherence',
    copy: 'score_copy',
    cro: 'score_cro',
    tov: 'score_tov',
    compliance: 'score_compliance',
  };
  const update: Record<string, unknown> = {
    results,
    [scoreCol[cat]]: results[cat]?.score ?? null,
  };
  const { error } = await supabase
    .from('funnel_checkpoints')
    .update(update)
    .eq('id', checkpointId);
  if (error) {
    console.warn(`[checkpoint/run] partial update for ${cat}: ${error.message}`);
  }
}

async function runClaudeCategory(args: {
  category: CheckpointCategory;
  funnelName: string;
  steps: MultiPagePromptStep[];
  brandProfile?: string;
}): Promise<CheckpointCategoryResult> {
  const { category } = args;
  const cfg = CATEGORY_PROMPT_CONFIG[category];
  const userMessage = buildMultiPageUserMessage(args);

  const { reply, usage } = await callClaudeWithKnowledge({
    task: cfg.task,
    instructions: cfg.instructions,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: cfg.maxTokens,
  });

  console.log(
    `[checkpoint/run] ${category} usage → ${summarizeUsage(usage)}`,
  );

  let parsed: unknown;
  try {
    parsed = extractJsonFromReply(reply);
  } catch (err) {
    return {
      score: null,
      status: 'error',
      summary: 'AI returned non-JSON reply.',
      issues: [],
      suggestions: [],
      rawReply: reply.slice(0, 4000),
      error: err instanceof Error ? err.message : String(err),
      usage,
    };
  }

  return normaliseCategoryResult(parsed, reply, usage);
}

function normaliseCategoryResult(
  parsed: unknown,
  rawReply: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number },
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
    usage,
  };
}
