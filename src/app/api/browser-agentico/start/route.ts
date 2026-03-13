import { NextRequest, NextResponse } from 'next/server';
import { createAgenticJob } from '@/lib/agentic-job-store';
import { runAgenticCrawl } from '@/lib/agentic-browser-runner';

/**
 * Start the agentic browser (Gemini Computer Use + Playwright) in background.
 * Returns jobId. The client polls via GET /api/browser-agentico/status/[jobId]
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      entryUrl,
      maxSteps = 100,
      viewportWidth = 1440,
      viewportHeight = 900,
    } = body;

    if (!entryUrl || typeof entryUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'entryUrl is required' },
        { status: 400 }
      );
    }

    const clampedMaxSteps = Math.min(100, Math.max(3, Number(maxSteps) || 100));

    const params = {
      entryUrl: entryUrl.trim(),
      maxSteps: clampedMaxSteps,
      viewportWidth: Number(viewportWidth) || 1440,
      viewportHeight: Number(viewportHeight) || 900,
    };

    const jobId = createAgenticJob(params.entryUrl, params);

    runAgenticCrawl(jobId, params).catch((err) => {
      console.error('Agentic browser error:', err);
    });

    return NextResponse.json({
      success: true,
      jobId,
      message: 'Agentic browser (Computer Use) started. Polling: GET /api/browser-agentico/status/' + jobId,
    });
  } catch (error) {
    console.error('Agentic browser start error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 }
    );
  }
}
