import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/crawl-job-store';

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

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found', status: 'not_found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error('Crawl status error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500 }
    );
  }
}
