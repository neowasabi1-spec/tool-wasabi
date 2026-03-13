import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/crawl-job-store';
import { runCrawl } from '@/lib/crawl-runner';

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

    const jobId = createJob(params.entryUrl, params);

    // Esegui in background - non await
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
