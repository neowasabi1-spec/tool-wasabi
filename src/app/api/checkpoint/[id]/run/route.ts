import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  callClaudeWithKnowledge,
  summarizeUsage,
} from '@/lib/anthropic-with-knowledge';
import {
  loadFunnelById,
  loadFunnelHtml,
} from '@/lib/checkpoint-sources';
import {
  CATEGORY_PROMPT_CONFIG,
  buildUserMessage,
  htmlToAuditText,
  extractJsonFromReply,
} from '@/lib/checkpoint-prompts';
import type {
  CheckpointCategory,
  CheckpointCategoryResult,
  CheckpointResults,
  CheckpointRunStatus,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — multi-category Claude call.

const ALL_CATEGORIES: CheckpointCategory[] = [
  'cro',
  'coherence',
  'tov',
  'compliance',
  'copy',
];

/**
 * POST /api/checkpoint/[id]/run
 *
 * Body (optional):
 *   {
 *     categories?: CheckpointCategory[],   // default: all
 *     brandProfile?: string,                // optional brand voice context
 *     productType?: 'supplement'|'digital'|'both', // for compliance routing
 *   }
 *
 * Lifecycle:
 *   1. Insert a row with status='running'
 *   2. Run categories sequentially (one Claude call each + 1 compliance fetch)
 *   3. Update the row with results, scores, status='completed' | 'partial'
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: compositeId } = await params;
  if (!compositeId) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  // Resolve target funnel.
  const funnel = await loadFunnelById(decodeURIComponent(compositeId));
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }

  // Parse body.
  let body: {
    categories?: CheckpointCategory[];
    brandProfile?: string;
    productType?: 'supplement' | 'digital' | 'both';
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const categories =
    body.categories && body.categories.length > 0
      ? body.categories.filter((c) => ALL_CATEGORIES.includes(c))
      : ALL_CATEGORIES;
  const productType = body.productType ?? 'both';
  const brandProfile = body.brandProfile;

  // Pull HTML to audit.
  const htmlBundle = await loadFunnelHtml(funnel);
  if (!htmlBundle) {
    return NextResponse.json(
      {
        error:
          'No HTML available for this funnel — neither swiped/cloned data nor live URL responded',
      },
      { status: 422 },
    );
  }

  // Prepare audit text once, reuse across categories.
  const auditText = htmlToAuditText(htmlBundle.html);

  // 1) Open the checkpoint row in `running` state so the UI can poll.
  const { data: insertedRow, error: insertErr } = await supabase
    .from('funnel_checkpoints')
    .insert({
      source_table: funnel.source_table,
      source_id: funnel.source_id,
      funnel_name: funnel.name,
      funnel_url: funnel.url,
      was_swiped: funnel.was_swiped,
      project_id: funnel.project_id,
      status: 'running' as CheckpointRunStatus,
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

  // 2) Run categories sequentially.
  const results: CheckpointResults = {};
  let errored = 0;
  let succeeded = 0;

  for (const cat of categories) {
    try {
      if (cat === 'compliance') {
        results[cat] = await runCompliance({
          html: htmlBundle.html,
          url: funnel.url,
          productType,
          requestUrl: req.url,
        });
      } else {
        results[cat] = await runClaudeCategory({
          category: cat,
          funnelName: funnel.name,
          funnelUrl: funnel.url,
          pageText: auditText,
          brandProfile,
        });
      }
      if (results[cat]?.status === 'error') errored++;
      else succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[checkpoint/run] category ${cat} crashed:`, msg);
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
  }

  // 3) Compute aggregate score (avg of numeric scores, ignoring null/error).
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

  // 4) Persist final state.
  const { error: updErr } = await supabase
    .from('funnel_checkpoints')
    .update({
      results,
      score_cro: results.cro?.score ?? null,
      score_coherence: results.coherence?.score ?? null,
      score_tov: results.tov?.score ?? null,
      score_compliance: results.compliance?.score ?? null,
      score_copy: results.copy?.score ?? null,
      score_overall: overall,
      status: finalStatus,
      completed_at: new Date().toISOString(),
    })
    .eq('id', checkpointId);

  if (updErr) {
    console.error('[checkpoint/run] update failed:', updErr.message);
    // Row exists but final state didn't persist — surface to client so it
    // can refetch and recover.
    return NextResponse.json(
      {
        id: checkpointId,
        status: finalStatus,
        score_overall: overall,
        results,
        warning: `Persistence partial: ${updErr.message}`,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    id: checkpointId,
    status: finalStatus,
    score_overall: overall,
    results,
    htmlSource: htmlBundle.source,
  });
}

async function runClaudeCategory(args: {
  category: CheckpointCategory;
  funnelName: string;
  funnelUrl: string;
  pageText: string;
  brandProfile?: string;
}): Promise<CheckpointCategoryResult> {
  const { category } = args;
  const cfg = CATEGORY_PROMPT_CONFIG[category];
  const userMessage = buildUserMessage(args);

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

async function runCompliance(args: {
  html: string;
  url: string;
  productType: 'supplement' | 'digital' | 'both';
  requestUrl: string;
}): Promise<CheckpointCategoryResult> {
  // Reuse the existing /api/compliance-ai/check endpoint. We call it
  // server-to-server (absolute URL derived from req.url) so we don't
  // duplicate its 200+ lines of section logic.
  const origin = new URL(args.requestUrl).origin;
  const targetUrl = `${origin}/api/compliance-ai/check`;

  // The existing endpoint runs ONE section at a time. We pick the
  // most generic / most-impactful section ("A1") which audits the
  // overall offer/refund/footer surface; the dedicated /compliance-ai
  // page can still run the full A1-E1 sweep.
  // TODO: extend to multi-section once the run endpoint supports it.
  const sectionId = 'A1';

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sectionId,
      funnelUrls: args.url ? [args.url] : [],
      funnelHtml: args.html.slice(0, 30000),
      productType: args.productType,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    return {
      score: null,
      status: 'error',
      summary: `Compliance endpoint returned HTTP ${res.status}`,
      issues: [],
      suggestions: [],
      error: txt.slice(0, 500),
    };
  }

  const data = (await res.json()) as {
    items?: Array<{
      title?: string;
      status?: 'pass' | 'fail' | 'warning' | 'not_applicable';
      explanation?: string;
      recommendation?: string;
    }>;
    summary?: string;
    overallStatus?: string;
  };
  const items = data.items ?? [];

  // Map compliance items → our shared issue/suggestion shape.
  const issues = items
    .filter((it) => it.status === 'fail' || it.status === 'warning')
    .map((it) => ({
      severity: (it.status === 'fail' ? 'critical' : 'warning') as
        | 'critical'
        | 'warning',
      title: it.title ?? 'Compliance check',
      detail: it.explanation,
    }));
  const suggestions = items
    .filter((it) => it.recommendation)
    .map((it) => ({
      title: it.title ?? 'Recommendation',
      detail: it.recommendation,
    }));

  // Score: pass=100 - 15*fails - 5*warnings (clamped 0-100).
  const fails = items.filter((it) => it.status === 'fail').length;
  const warnings = items.filter((it) => it.status === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - 15 * fails - 5 * warnings));

  let status: CheckpointCategoryResult['status'];
  if (fails > 0) status = 'fail';
  else if (warnings > 0) status = 'warn';
  else status = 'pass';

  return {
    score,
    status,
    summary:
      data.summary ??
      `${items.length} checks (${fails} fail / ${warnings} warning).`,
    issues,
    suggestions,
  };
}
