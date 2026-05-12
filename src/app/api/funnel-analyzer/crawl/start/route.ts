import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/crawl-job-store';
import { runCrawl } from '@/lib/crawl-runner';

// 5-minute ceiling: matches Netlify's hard cap and gives the
// background crawl room to finish inside this lambda's lifecycle.
// Without this the lambda would die at ~10s (free) / 26s (Pro
// default), the unawaited runCrawl promise would be killed mid-flight,
// and the job row in funnel_crawl_jobs would stay in `running` forever.
export const maxDuration = 300;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Avvia un crawl in background. Ritorna subito con jobId.
 * Il client deve fare polling su GET /api/funnel-analyzer/crawl/status/[jobId]
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      entryUrl,
      maxSteps = 15,
      maxDepth = 3,
      followSameOriginOnly = true,
      captureScreenshots = true,
      captureNetwork = true,
      captureCookies = true,
      viewportWidth = 1280,
      viewportHeight = 720,
      quizMode = false,
      quizMaxSteps = 20,
    } = body;

    if (!entryUrl || typeof entryUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'entryUrl is required' },
        { status: 400 }
      );
    }

    const params = {
      entryUrl: entryUrl.trim(),
      headless: true,
      maxSteps,
      maxDepth,
      followSameOriginOnly,
      captureScreenshots,
      captureNetwork,
      captureCookies,
      viewportWidth,
      viewportHeight,
      quizMode,
      quizMaxSteps,
    };

    const jobId = await createJob(params.entryUrl, params);

    // Run the crawl INSIDE this lambda's lifetime. We deliberately
    // skip awaiting the promise so the response goes back to the
    // client immediately (it just wants the jobId), but on Netlify
    // the lambda is kept warm for `maxDuration` (300s) which gives
    // runCrawl enough wall time to populate funnel_crawl_jobs with
    // progress and final result. Job state is now persisted to
    // Supabase, so even if the lambda is recycled mid-crawl the
    // status endpoint still finds the row (with whatever step we
    // got to) instead of returning "Job not found".
    runCrawl(jobId, params).catch((err) => {
      console.error('Background crawl error:', err);
    });

    return NextResponse.json({
      success: true,
      jobId,
      message: 'Crawl started in background. Use GET /api/funnel-analyzer/crawl/status/' + jobId + ' for status.',
    });
  } catch (error) {
    console.error('Crawl start error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 }
    );
  }
}
