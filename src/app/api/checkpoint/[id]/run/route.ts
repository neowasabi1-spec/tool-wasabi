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
  pageTypeToTask,
  type MultiPagePromptStep,
} from '@/lib/checkpoint-prompts';
import {
  CHECKPOINT_RUN_CATEGORIES,
  type CheckpointCategory,
  type CheckpointCategoryResult,
  type CheckpointResults,
  type CheckpointRunStatus,
} from '@/types/checkpoint';

/** Recognised auditor identifiers. 'claude' is the built-in pipeline.
 *  'openclaw:*' values match the OPENCLAW_MODEL env var the user
 *  configures on each worker (Neo's PC sets OPENCLAW_MODEL=openclaw:neo,
 *  Morfeo's PC sets openclaw:morfeo, etc). The string after the colon
 *  is opaque to us — we only relay it as `target_agent` on the queue
 *  row, so the matching worker is the only one that can claim it. */
type AuditorId = 'claude' | `openclaw:${string}`;
function isOpenclawAuditor(a: string): a is `openclaw:${string}` {
  return a.startsWith('openclaw:') && a.length > 'openclaw:'.length;
}

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
    /** Who runs the audit. Default 'claude' (in-process, blocking).
     *  'openclaw:neo' / 'openclaw:morfeo' enqueue the work for the
     *  matching OpenClaw worker via the openclaw_messages queue and
     *  return immediately with the runId. */
    auditor?: AuditorId;
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
  const auditor: AuditorId = body.auditor ?? 'claude';

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
    `[checkpoint/run] start runId=${checkpointId} funnel="${funnel.name}" pages=${funnel.pages.length} categories=${categories.join(',')} auditor=${auditor}`,
  );

  // Fetch HTML for ALL pages, in order, AFTER opening the row. If
  // every page fails we close the row as failed; if at least one
  // succeeded we keep going (the AI prompts are designed to surface
  // [FETCH-ERROR] pages as missing).
  //
  // When the run includes the `coherence` (Visual) category we also
  // capture mobile screenshots of every page and upload them to
  // Supabase Storage so the vision-capable Claude can see actual
  // rendered pixels (typography / contrast / hero / spacing). Done
  // here instead of inside runClaudeCategory so the screenshots are
  // a one-time cost per run regardless of category re-runs.
  const needsScreenshots = categories.includes('coherence');
  const pagesHtml = await fetchFunnelPagesHtml(funnel.pages, {
    withScreenshots: needsScreenshots,
    runId: checkpointId,
  });
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
  // cost when categories > 1). Screenshot URLs travel alongside so
  // the Visual audit can attach them as image content blocks.
  const auditSteps: MultiPagePromptStep[] = pagesHtml.map((p) => ({
    index: p.index + 1,
    url: p.url,
    name: p.name,
    pageType: p.pageType,
    pageText: p.html ? htmlToAuditText(p.html) : '',
    fetchError: p.error ?? null,
    screenshotMobileUrl: p.screenshotMobileUrl ?? null,
  }));

  // ── Fork: external (OpenClaw) auditors ───────────────────────────
  // For openclaw:* we pre-build every category prompt server-side,
  // ship them as a single openclaw_messages row tagged with the
  // target_agent, and return the runId immediately. The matching
  // worker will stream the per-category results back via
  // /api/checkpoint/runs/[runId]/openclaw-category and close the run
  // via /openclaw-finalize. This bypasses Claude entirely and offloads
  // the heavy LLM work to the user's machine, where there's no
  // serverless timeout.
  if (isOpenclawAuditor(auditor)) {
    const prompts = categories
      .filter((cat) => {
        if (cat === 'navigation' && reachable.length < 2) {
          // Persist a "skipped" placeholder server-side so the UI
          // shows the same explanation Claude would have produced,
          // and don't ship navigation to OpenClaw.
          return false;
        }
        return true;
      })
      .map((cat) => {
        const cfg = CATEGORY_PROMPT_CONFIG[cat];
        return {
          category: cat,
          system: cfg.instructions,
          user: buildMultiPageUserMessage({
            category: cat,
            funnelName: funnel.name,
            steps: auditSteps,
            brandProfile,
          }),
        };
      });

    // Pre-persist any "skipped" categories (navigation only for now).
    const preSkipped: CheckpointResults = {};
    for (const cat of categories) {
      if (cat === 'navigation' && reachable.length < 2) {
        preSkipped[cat] = {
          score: null,
          status: 'skipped',
          summary:
            "Il check Navigazione richiede almeno 2 pagine raggiungibili nel funnel.",
          issues: [],
          suggestions: [],
        };
      }
    }
    if (Object.keys(preSkipped).length > 0) {
      await supabase
        .from('funnel_checkpoints')
        .update({ results: preSkipped })
        .eq('id', checkpointId);
    }

    if (prompts.length === 0) {
      // Nothing left to ask the worker → finalise as completed/failed
      // here without bothering the queue.
      const completedAt = new Date().toISOString();
      await supabase
        .from('funnel_checkpoints')
        .update({
          status: 'completed' as CheckpointRunStatus,
          completed_at: completedAt,
        })
        .eq('id', checkpointId);
      return NextResponse.json({
        runId: checkpointId,
        status: 'completed',
        auditor,
        message: 'No categories required external audit (all skipped).',
      });
    }

    const queuePayload = {
      runId: checkpointId,
      funnelId: funnel.id,
      funnelName: funnel.name,
      prompts,
    };
    const { error: enqueueErr } = await supabase
      .from('openclaw_messages')
      .insert({
        section: 'checkpoint_audit',
        target_agent: auditor,
        status: 'pending',
        user_message: JSON.stringify(queuePayload),
        system_prompt: null,
      });
    if (enqueueErr) {
      const msg = `Failed to enqueue OpenClaw job: ${enqueueErr.message}`;
      await supabase
        .from('funnel_checkpoints')
        .update({
          status: 'failed' as CheckpointRunStatus,
          error: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', checkpointId);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    return NextResponse.json({
      runId: checkpointId,
      status: 'running' as CheckpointRunStatus,
      auditor,
      enqueuedCategories: prompts.map((p) => p.category),
      message:
        `Job sent to ${auditor}. Poll /api/checkpoint/runs/${checkpointId} for live status.`,
    });
  }

  // ── Default: in-process Claude pipeline ─────────────────────────
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

  // When every step shares the same page type, override the category's
  // default `task` (used for the Tier 2 KB injection) with the type-
  // specific bundle so the Landing single-page flow gets, e.g., the
  // Advertorial knowledge tier rather than a generic 'vsl' default.
  // Mixed-type funnels keep the category default — there's no single
  // "right" bundle for a 3-step advertorial → VSL → checkout sequence.
  const types = Array.from(
    new Set(
      args.steps
        .map((s) => (s.pageType ?? '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const dominantTask =
    types.length === 1 ? pageTypeToTask(types[0]) : null;
  const taskForKB = dominantTask ?? cfg.task;
  if (dominantTask && dominantTask !== cfg.task) {
    console.log(
      `[checkpoint/run] ${category} pageType=${types[0]} → KB task override "${cfg.task}" → "${dominantTask}"`,
    );
  }

  // Visual audit is the only category that benefits from images.
  // We attach one mobile screenshot per step (when uploaded
  // successfully) so Claude vision can verify typography / colors /
  // hero quality / mobile layout — checks the prompt previously had
  // to mark NOT VERIFIED. Hard cap at 12 images to stay well within
  // Anthropic's request limits and avoid runaway token cost.
  const images =
    category === 'coherence'
      ? args.steps
          .filter((s) => !!s.screenshotMobileUrl)
          .slice(0, 12)
          .map((s) => ({
            url: s.screenshotMobileUrl as string,
            label: `[Step ${s.index}${s.name ? ' — ' + s.name : ''}] mobile screenshot (390×844 viewport)`,
          }))
      : undefined;

  if (images && images.length > 0) {
    console.log(
      `[checkpoint/run] ${category} attaching ${images.length} mobile screenshot(s) to vision call`,
    );
  } else if (category === 'coherence') {
    console.warn(
      `[checkpoint/run] ${category} running WITHOUT screenshots (capture failed for all eligible steps) — falling back to text-only audit`,
    );
  }

  const { reply, usage } = await callClaudeWithKnowledge({
    task: taskForKB,
    instructions: cfg.instructions,
    messages: [{ role: 'user', content: userMessage, images }],
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
