import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/crawl-job-store';

// IMPORTANT: this route is polled every 1.5s by the client to track
// crawl progress. Next 14's Route Handler data cache will happily
// serve a stale "still running" snapshot for minutes if we don't opt
// out, which is exactly what made the modal hang on "Sto esplorando…"
// after the worker had already written status=completed to Supabase.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * Polling for crawl status and result.
 * GET /api/funnel-analyzer/crawl/status/[jobId]
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId is required' },
        { status: 400 }
      );
    }

    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found', status: 'not_found' },
        { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        jobId: job.id,
        status: job.status,
        entryUrl: job.entryUrl,
        currentStep: job.currentStep,
        totalSteps: job.totalSteps,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    console.error('Crawl status error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  }
}
