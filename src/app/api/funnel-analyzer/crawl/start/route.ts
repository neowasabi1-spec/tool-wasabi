import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/crawl-job-store';

// Lightweight enqueue-only endpoint. We used to launch Playwright
// inline here as a fire-and-forget promise, but on Netlify the lambda
// waits for an empty event loop before sending the response. Chromium
// keeps the loop busy for tens of seconds, the wrapping Edge Middleware
// times out at ~30s, and the client receives an HTML error page that
// fails to parse as JSON ("Unexpected token 'h', 'the edge fu…'").
//
// Now the heavy work lives on the user's machine: the openclaw-worker
// polls funnel_crawl_jobs every few seconds, claims pending rows, runs
// the crawl with local Playwright (no time budget), and writes the
// result back to the same row. This route only inserts the row and
// returns the id — sub-second, no Edge Function timeout.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Enqueue a funnel crawl. Returns immediately with jobId.
 * Il client deve fare polling su GET /api/funnel-analyzer/crawl/status/[jobId]
 * — il worker locale processa l'effettivo crawl.
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

    // Strip Facebook / ad-network placeholders like {{ad.id}}, {{adset.id}},
    // {{campaign.name}}, {{site_source_name}}, {{placement}}.  These are
    // resolved by Facebook *at click time*; if we hand them straight to
    // Playwright the tracking domain often 400s or 302-loops while waiting
    // for variables that will never show up, and the job sits at "running"
    // until we hit the lambda timeout.  Strip-and-go is way better than
    // erroring, so we replace the whole `{{…}}` token with an empty
    // string and let the tracker do its best with empty UTMs.
    let cleanedEntryUrl = entryUrl.trim();
    const placeholderRe = /\{\{[^{}]+\}\}/g;
    if (placeholderRe.test(cleanedEntryUrl)) {
      const stripped = cleanedEntryUrl.match(placeholderRe) || [];
      cleanedEntryUrl = cleanedEntryUrl.replace(placeholderRe, '');
      console.log(
        `[crawl/start] stripped ${stripped.length} placeholder(s) from entryUrl: ${stripped.join(', ')}`,
      );
    }

    // Hard ceiling on steps. Each Playwright navigation takes 30-120s on
    // a real site, and the Netlify lambda dies after 300s (see netlify.toml).
    // A maxSteps higher than ~30 cannot physically finish before the
    // lambda is recycled, leaving the row stuck on `running` forever and
    // the polling client erroring out with "Timeout: il crawler ha
    // impiegato troppo".  If you need more than 30 pages, use the manual
    // entry mode instead of auto-discovery.
    const cappedMaxSteps = Math.min(Math.max(1, Number(maxSteps) || 15), 30);

    const params = {
      entryUrl: cleanedEntryUrl,
      headless: true,
      maxSteps: cappedMaxSteps,
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
    console.log(
      `[crawl/start] queued job ${jobId} for ${params.entryUrl} (maxSteps=${params.maxSteps}, quizMode=${params.quizMode})`,
    );

    return NextResponse.json({
      success: true,
      jobId,
      message:
        'Crawl enqueued. The local openclaw-worker will pick it up within ~5s. ' +
        'GET /api/funnel-analyzer/crawl/status/' + jobId + ' for status.',
    });
  } catch (error) {
    console.error('Crawl start error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 }
    );
  }
}
