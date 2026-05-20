import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/crawl-job-store';

/**
 * Polling per il walk-quiz job. Stesso schema del Funnel Analyzer
 * (`/api/funnel-analyzer/crawl/status/[jobId]`), restituisce status +
 * result. La differenza chiave: `result.steps[i].html` e' popolato
 * perche' la POST /api/walk-quiz ha settato params.captureHtml=true.
 *
 * Restituisce un payload minimale ma con tutte le info che la UI di
 * /quiz-swipe usa per renderizzare la lista step e abilitare lo
 * swipe per-step.
 *
 * Polled dal client ogni 1.5s — opt-out completo della cache di Next.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    if (!jobId) {
      return NextResponse.json(
        { ok: false, error: 'jobId is required' },
        { status: 400 },
      );
    }

    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json(
        { ok: false, error: 'Job not found', status: 'not_found' },
        { status: 404, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        jobId: job.id,
        status: job.status,
        entryUrl: job.entryUrl,
        currentStep: job.currentStep ?? 0,
        totalSteps: job.totalSteps ?? 0,
        result: job.result ?? null,
        error: job.error ?? null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    console.error('[walk-quiz] status error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
