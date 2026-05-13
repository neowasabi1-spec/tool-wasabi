import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
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
 * Stream an "alive" heartbeat (a single space) every `heartbeatMs`
 * while `work()` runs, then emit the final JSON object as the last
 * chunk and close the stream.
 *
 * Why this exists:
 *   The OpenClaw worker calls this endpoint and waits up to 5min for
 *   the response. Netlify's edge CDN, however, kills any HTTP
 *   connection that goes ~25-30s without sending bytes back to the
 *   client (the well-known "Inactivity Timeout" 504 with a Squid-
 *   style HTML body). Fetching 25 SPA pages with Playwright can
 *   easily take >30s before the first byte is ready, so the worker
 *   used to receive a 504 even though the function was healthy.
 *
 * Why spaces are safe:
 *   JSON allows arbitrary leading and trailing whitespace per the
 *   spec — `"   {…}   "` parses identically to `"{…}"`. The heartbeat
 *   spaces accumulate at the head of the body, then we append the
 *   real JSON object as one atomic chunk. The worker's
 *   `JSON.parse(buf)` reads the whole concatenated buffer and yields
 *   the same object, no protocol change needed.
 *
 * Errors are returned as `{ error: "..." }` with HTTP 200 (we can't
 * change the status code after streaming starts). Callers should
 * branch on `parsed.error`.
 */
function streamWithHeartbeat<T>(
  work: () => Promise<T>,
  opts: { heartbeatMs?: number } = {},
): Response {
  const heartbeatMs = opts.heartbeatMs ?? 7000;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let done = false;
      const heartbeat = setInterval(() => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(' '));
        } catch {
          // Stream already closed (client disconnected) — let the
          // work() promise settle normally; the next interval tick
          // will be a no-op because `done` will flip.
        }
      }, heartbeatMs);
      try {
        const result = await work();
        done = true;
        clearInterval(heartbeat);
        controller.enqueue(encoder.encode(JSON.stringify(result)));
        controller.close();
      } catch (err) {
        done = true;
        clearInterval(heartbeat);
        const msg = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: msg })),
          );
          controller.close();
        } catch {
          // Already closed — nothing else we can do.
        }
      }
    },
    cancel() {
      // Client (worker) bailed mid-stream. work() will keep running
      // to completion in the background but its output is dropped.
      // No cleanup needed because the function will exit on its own
      // when the function instance is recycled.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // Defeat any reverse-proxy buffering (nginx in front of Lambda,
      // some Cloudflare configs). Without this header some edges hold
      // the response in a buffer until "enough" data arrives, which
      // negates the whole point of the heartbeat.
      'X-Accel-Buffering': 'no',
    },
  });
}

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
    // Missing-id is detectable BEFORE we start streaming, so we can
    // still return a proper 400 with a normal JSON body.
    return NextResponse.json({ error: 'Missing funnel id' }, { status: 400 });
  }

  let body: {
    categories?: CheckpointCategory[];
    brandProfile?: string;
    /** Optional run id. When provided, this prep step writes "stage
     *  hints" into funnel_checkpoints.error (with the literal "[stage] "
     *  prefix) so the dashboard's polling client can show the user
     *  WHAT we're doing during the 30–90s prep window. Backwards
     *  compatible: older workers omit this field and the prep simply
     *  runs silently as before. */
    runId?: string;
  } = {};
  try { body = await req.json(); } catch { body = {}; }

  // Heavy work goes inside the streamed wrapper so the worker stays
  // connected during the 30s+ page fetch / SPA-render window.
  // Errors are returned as { error } (HTTP 200 streamed body); the
  // worker's catch around `prep.error` handles them as failures.
  return streamWithHeartbeat(async () => {
    const funnel = await getFunnel(id);
    if (!funnel) {
      throw new Error('Funnel not found');
    }
    if (!funnel.pages || funnel.pages.length === 0) {
      throw new Error('Funnel has no pages configured.');
    }

    const categories: CheckpointCategory[] =
      body.categories && body.categories.length > 0
        ? body.categories
        : [...CHECKPOINT_RUN_CATEGORIES];
    const brandProfile = body.brandProfile ?? funnel.brand_profile ?? undefined;
    const runId = typeof body.runId === 'string' && body.runId ? body.runId : null;

    const writeStageHint = runId
      ? async (msg: string) => {
          try {
            await supabase
              .from('funnel_checkpoints')
              .update({ error: `[stage] ${msg}` })
              .eq('id', runId);
          } catch (e) {
            console.warn('[openclaw-prep] writeStageHint failed:', e);
          }
        }
      : undefined;

    // OpenClaw / Trinity is text-only — capturing mobile screenshots
    // here would just burn 30-60s with no benefit (the local LLM can't
    // see images). The Claude pipeline path captures them inside its
    // own /run route. Here we only forward stage hints so the dashboard
    // can show prep progress.
    const pagesHtml = await fetchFunnelPagesHtml(funnel.pages, {
      onStage: writeStageHint,
    });
    const reachable = pagesHtml.filter((p) => p.html && p.html.length > 0);
    if (reachable.length === 0) {
      throw new Error(
        "Nessuna pagina del funnel è stata scaricata. URL irraggiungibili o tutte le risposte vuote.",
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
      // NOTE: 'navigation' = Tech/Detail QC audit. Almost every check
      // (swipe residuals, brand consistency, mechanism naming, broken
      // CTAs, prices, guarantees, footer, …) is single-page. Only the
      // 1B/1C "across pages" sub-sections need ≥2 steps and the
      // prompt itself tells the model to mark those NOT VERIFIED on
      // a 1-page funnel rather than bailing out. So we run it
      // unconditionally — same as the Claude pipeline.
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

    return {
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
    };
  });
}
