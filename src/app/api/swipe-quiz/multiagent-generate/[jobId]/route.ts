import { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * GET /api/swipe-quiz/multiagent-generate/[jobId]
 *
 * Polls the status of a background multiagent generation job.
 * Returns current phase, progress log, and — when completed — the result HTML.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;

  if (!jobId) {
    return new Response(
      JSON.stringify({ error: 'jobId required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { data: job, error } = await supabase
    .from('multiagent_jobs')
    .select('id, status, current_phase, progress, master_spec, branding, result_html, error, usage, entry_url, funnel_name, created_at, updated_at')
    .eq('id', jobId)
    .single();

  if (error || !job) {
    return new Response(
      JSON.stringify({ error: `Job non trovato: ${error?.message || 'not found'}` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Build response based on job status
  const response: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    currentPhase: job.current_phase,
    progress: job.progress,
    entryUrl: job.entry_url,
    funnelName: job.funnel_name,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };

  if (job.status === 'completed') {
    response.resultHtml = job.result_html;
    response.usage = job.usage;
    response.masterSpecSummary = job.master_spec
      ? {
          confidence: (job.master_spec as Record<string, unknown>).synthesis_notes
            ? ((job.master_spec as Record<string, unknown>).synthesis_notes as Record<string, unknown>).confidence_score
            : null,
          agentsUsed: (job.master_spec as Record<string, unknown>).metadata
            ? ((job.master_spec as Record<string, unknown>).metadata as Record<string, unknown>).agents_used
            : null,
        }
      : null;
    response.brandingSteps = job.branding
      ? ((job.branding as Record<string, unknown>).funnelSteps as unknown[])?.length ?? 0
      : 0;
  }

  if (job.status === 'failed') {
    response.error = job.error;
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * DELETE /api/swipe-quiz/multiagent-generate/[jobId]
 *
 * Cancels/deletes a job (useful for cleanup).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;

  const { error } = await supabase
    .from('multiagent_jobs')
    .delete()
    .eq('id', jobId);

  if (error) {
    return new Response(
      JSON.stringify({ error: `Impossibile eliminare il job: ${error.message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ deleted: true, jobId }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
