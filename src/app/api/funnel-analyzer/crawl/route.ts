import { NextRequest, NextResponse } from 'next/server';

/**
 * DEPRECATO: usa POST /api/funnel-analyzer/crawl/start per avviare un crawl in background.
 * Synchronous crawl was removed to avoid HTTP timeouts.
 */
export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      error: 'Deprecated endpoint. Use POST /api/funnel-analyzer/crawl/start to start the crawl in background, then GET /api/funnel-analyzer/crawl/status/[jobId] for status.',
      migration: {
        start: '/api/funnel-analyzer/crawl/start',
        status: '/api/funnel-analyzer/crawl/status/{jobId}',
      },
    },
    { status: 410 }
  );
}
