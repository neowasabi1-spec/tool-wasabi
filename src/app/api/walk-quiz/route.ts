import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/crawl-job-store';

/**
 * Enqueue di un walk-quiz job per la sezione Clone / Swipe Quiz.
 *
 * Riutilizza l'infrastruttura del Funnel Analyzer (tabella
 * `funnel_crawl_jobs` + worker locale Playwright che gia' sa fare il
 * crawl quiz), passando due flag distintivi nei `params`:
 *   - source: 'quiz-swipe'  → tagga la riga per filtrarla dal Checkpoint
 *   - captureHtml: true     → fa salvare al worker anche il DOM HTML per
 *                              ogni step (di default e' solo screenshot),
 *                              cosi' ogni step diventa swipabile.
 *
 * Lambda-friendly: insert sub-secondo, niente Playwright qui.
 * Client deve fare polling su GET /api/walk-quiz/status/[jobId].
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      url,
      maxSteps = 15,
      targetAgent = null,
    } = body as { url?: string; maxSteps?: number; targetAgent?: string | null };

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'url is required' },
        { status: 400 },
      );
    }
    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { ok: false, error: 'url is not a valid URL' },
        { status: 400 },
      );
    }

    const cappedMaxSteps = Math.min(Math.max(1, Number(maxSteps) || 15), 60);

    const params = {
      entryUrl: url.trim(),
      headless: true,
      maxSteps: cappedMaxSteps,
      quizMaxSteps: cappedMaxSteps,
      // Forza quizMode anche se l'infra accetta il flag — il walker gira
      // comunque per fingerprint, ma rendiamolo esplicito per chiarezza.
      quizMode: true,
      // Flag specifici quiz-swipe:
      captureHtml: true,
      source: 'quiz-swipe',
      captureScreenshots: true,
      captureNetwork: false,
      captureCookies: false,
      viewportWidth: 1280,
      viewportHeight: 800,
    };

    let resolvedTargetAgent: string | null = null;
    if (typeof targetAgent === 'string' && targetAgent.trim()) {
      const t = targetAgent.trim().toLowerCase();
      if (t === 'neo' || t === 'morfeo') {
        resolvedTargetAgent = `openclaw:${t}`;
      } else if (t.startsWith('openclaw:')) {
        resolvedTargetAgent = t;
      }
    }

    const jobId = await createJob(params.entryUrl, params, resolvedTargetAgent);
    console.log(
      `[walk-quiz] queued job ${jobId} for ${params.entryUrl} (maxSteps=${cappedMaxSteps}, target=${resolvedTargetAgent || 'any'})`,
    );

    return NextResponse.json({
      ok: true,
      jobId,
      message:
        'Walk enqueued. Il worker Playwright locale lo prendera\' entro pochi secondi. ' +
        'GET /api/walk-quiz/status/' + jobId + ' per stato.',
    });
  } catch (error) {
    console.error('[walk-quiz] start error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 },
    );
  }
}
