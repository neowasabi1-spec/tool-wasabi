import { NextRequest, NextResponse } from 'next/server';
import {
  getFunnel,
  fetchFunnelPagesHtml,
} from '@/lib/checkpoint-store';
import {
  CATEGORY_PROMPT_CONFIG,
  QUIZ_CATEGORY_PROMPT_OVERRIDES,
  buildMultiPageUserMessage,
  htmlToAuditText,
  isAllQuizSteps,
  type MultiPagePromptStep,
} from '@/lib/checkpoint-prompts';
import {
  CHECKPOINT_RUN_CATEGORIES,
  type CheckpointCategory,
} from '@/types/checkpoint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/checkpoint/[id]/openclaw-prep
 *
 * Heavy-but-bounded helper called by the OpenClaw worker after it
 * picks a `checkpoint_audit` job from the queue. Centralises the
 * server-only work so the worker stays a thin Node script:
 *
 *   1. Fetch live HTML for every page in the funnel (in parallel,
 *      with the SPA-aware Playwright fallback).
 *   2. Convert each HTML blob into compact audit text.
 *   3. Build the per-category prompts (system + user) using the
 *      EXACT same templates as the built-in Claude pipeline, so
 *      Claude / Neo / Morfeo audits stay comparable.
 *
 * Returns:
 *   {
 *     funnelName,
 *     reachableCount,
 *     prompts: [{ category, system, user }, ...],
 *     skipped: [{ category, reason }, ...]
 *   }
 *
 * Body:
 *   {
 *     categories?: CheckpointCategory[],
 *     brandProfile?: string
 *   }
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
  if (!funnel.pages || funnel.pages.length === 0) {
    return NextResponse.json(
      { error: 'Funnel has no pages configured.' },
      { status: 422 },
    );
  }

  let body: { categories?: CheckpointCategory[]; brandProfile?: string } = {};
  try { body = await req.json(); } catch { body = {}; }
  const categories: CheckpointCategory[] =
    body.categories && body.categories.length > 0
      ? body.categories
      : [...CHECKPOINT_RUN_CATEGORIES];
  const brandProfile = body.brandProfile ?? funnel.brand_profile ?? undefined;

  const pagesHtml = await fetchFunnelPagesHtml(funnel.pages);
  const reachable = pagesHtml.filter((p) => p.html && p.html.length > 0);
  if (reachable.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nessuna pagina del funnel è stata scaricata. URL irraggiungibili o tutte le risposte vuote.",
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

  const auditSteps: MultiPagePromptStep[] = pagesHtml.map((p) => ({
    index: p.index + 1,
    url: p.url,
    name: p.name,
    pageText: p.html ? htmlToAuditText(p.html) : '',
    fetchError: p.error ?? null,
    pageType: p.pageType,
  }));

  // Match the Claude pipeline: when EVERY step is a quiz/survey/
  // assessment page we swap the standard prompts for the dedicated
  // QUIZ funnel rubric. Without this swap the OpenClaw worker was
  // running the generic copy/coherence/cro prompts on a quiz funnel,
  // which is why the columns were coming back thin or empty when
  // the user picked "Neo (OpenClaw)" on a quiz Landing.
  const quizMode = isAllQuizSteps(auditSteps);

  const prompts: { category: CheckpointCategory; system: string; user: string }[] = [];
  const skipped: { category: CheckpointCategory; reason: string }[] = [];
  for (const cat of categories) {
    if (cat === 'navigation' && reachable.length < 2) {
      skipped.push({
        category: cat,
        reason:
          "Il check Navigazione richiede almeno 2 pagine raggiungibili nel funnel.",
      });
      continue;
    }
    const cfg =
      (quizMode ? QUIZ_CATEGORY_PROMPT_OVERRIDES[cat] : undefined) ??
      CATEGORY_PROMPT_CONFIG[cat];
    prompts.push({
      category: cat,
      system: cfg.instructions,
      user: buildMultiPageUserMessage({
        category: cat,
        funnelName: funnel.name,
        steps: auditSteps,
        brandProfile,
      }),
    });
  }

  return NextResponse.json({
    funnelId: funnel.id,
    funnelName: funnel.name,
    reachableCount: reachable.length,
    pageCount: funnel.pages.length,
    pages: pagesHtml.map((p) => ({
      index: p.index,
      url: p.url,
      ok: !!p.html,
      htmlLength: p.htmlLength,
      error: p.error,
    })),
    prompts,
    skipped,
    durationMs: Date.now() - t0,
  });
}
