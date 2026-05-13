import { NextRequest, NextResponse } from 'next/server';
import { getFunnel } from '@/lib/checkpoint-store';
import {
  CATEGORY_PROMPT_CONFIG,
  QUIZ_CATEGORY_PROMPT_OVERRIDES,
  buildMultiPageUserMessage,
  isAllQuizSteps,
  type MultiPagePromptStep,
} from '@/lib/checkpoint-prompts';
import {
  CHECKPOINT_RUN_CATEGORIES,
  type CheckpointCategory,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/checkpoint/[id]/openclaw-build-prompts
 *
 * The "fast half" of openclaw-prep. The OpenClaw worker now does the
 * heavy page fetch LOCALLY using its own Playwright (no Netlify
 * function timeouts, no edge-CDN inactivity 504s) and then POSTs the
 * already-extracted audit text here. We just glue the text into the
 * per-category prompts and return them — no fetch, no SPA render,
 * <2s for any reasonable funnel size.
 *
 * Why split the original openclaw-prep:
 *   The 25-page funnel kept tripping Netlify's edge inactivity timeout
 *   at ~28s because Playwright doesn't emit any bytes back to the
 *   client mid-fetch. We tried streaming a whitespace heartbeat from
 *   the function — Netlify's wrapper around Lambda BUFFERS the
 *   response anyway, so the heartbeat never reached the worker. Only
 *   real fix: keep the slow work off the platform entirely.
 *
 * Body:
 *   {
 *     categories?: CheckpointCategory[],
 *     brandProfile?: string,
 *     auditSteps: [
 *       {
 *         index: number,        // 1-based
 *         url: string,
 *         name?: string,
 *         pageText: string,     // already passed through htmlToAuditText
 *         pageType?: string,
 *         fetchError?: string | null,
 *       },
 *       …
 *     ]
 *   }
 *
 * Returns:
 *   {
 *     funnelId, funnelName,
 *     reachableCount,           // steps with non-empty pageText
 *     pageCount,                // total steps received
 *     prompts: [{ category, system, user }, …],
 *     skipped: [{ category, reason }, …]
 *   }
 *
 * Errors:
 *   400  Missing id / malformed body
 *   404  Funnel not found
 *   422  No reachable steps (every page has empty pageText)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const t0 = Date.now();
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  const funnel = await getFunnel(id);
  if (!funnel) {
    return NextResponse.json({ error: 'Funnel not found' }, { status: 404 });
  }

  let body: {
    categories?: CheckpointCategory[];
    brandProfile?: string;
    auditSteps?: Array<{
      index: number;
      url: string;
      name?: string;
      pageText?: string;
      pageType?: string;
      fetchError?: string | null;
    }>;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: 'Body must be valid JSON' },
      { status: 400 },
    );
  }

  const auditSteps = Array.isArray(body.auditSteps) ? body.auditSteps : [];
  if (auditSteps.length === 0) {
    return NextResponse.json(
      { error: 'auditSteps[] is required and must contain at least one step.' },
      { status: 400 },
    );
  }

  const categories: CheckpointCategory[] =
    body.categories && body.categories.length > 0
      ? body.categories
      : [...CHECKPOINT_RUN_CATEGORIES];
  const brandProfile = body.brandProfile ?? funnel.brand_profile ?? undefined;

  const reachable = auditSteps.filter(
    (s) => typeof s.pageText === 'string' && s.pageText.length > 0,
  );
  if (reachable.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nessuno step ha testo utile da analizzare (tutte le pagine sono arrivate vuote dal worker).",
        pages: auditSteps.map((s) => ({
          index: s.index,
          url: s.url,
          ok: false,
          error: s.fetchError ?? 'pageText empty',
        })),
      },
      { status: 422 },
    );
  }

  const stepsForPrompt: MultiPagePromptStep[] = auditSteps.map((s) => ({
    index: s.index,
    url: s.url,
    name: s.name,
    pageText: s.pageText ?? '',
    fetchError: s.fetchError ?? null,
    pageType: s.pageType,
  }));

  // Mirror the Claude pipeline: when EVERY step is a quiz/survey
  // page, swap the standard prompts for the QUIZ rubric so the audit
  // matches the page's role.
  const quizMode = isAllQuizSteps(stepsForPrompt);

  const prompts: { category: CheckpointCategory; system: string; user: string }[] = [];
  const skipped: { category: CheckpointCategory; reason: string }[] = [];
  for (const cat of categories) {
    const cfg =
      (quizMode ? QUIZ_CATEGORY_PROMPT_OVERRIDES[cat] : undefined) ??
      CATEGORY_PROMPT_CONFIG[cat];
    prompts.push({
      category: cat,
      system: cfg.instructions,
      user: buildMultiPageUserMessage({
        category: cat,
        funnelName: funnel.name,
        steps: stepsForPrompt,
        brandProfile,
      }),
    });
  }

  return NextResponse.json({
    funnelId: funnel.id,
    funnelName: funnel.name,
    reachableCount: reachable.length,
    pageCount: auditSteps.length,
    pages: auditSteps.map((s) => ({
      index: s.index,
      url: s.url,
      ok: !!(s.pageText && s.pageText.length > 0),
      textLength: s.pageText?.length ?? 0,
      error: s.fetchError ?? null,
    })),
    prompts,
    skipped,
    durationMs: Date.now() - t0,
  });
}
