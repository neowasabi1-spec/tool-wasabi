import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { runStep } from '@/lib/pipeline/steps';
import {
  STEP_OUTPUT_PREVIEW_CHARS,
  type PipelineInput,
  type PipelineStepState,
  type StepKey,
} from '@/lib/pipeline/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/pipeline/step  — run ONE pipeline step and persist its state.
 *
 * Body: { jobId, stepKey }
 *
 * IMPORTANT — streaming heartbeat:
 * A step performs a 30–90s LLM call. Netlify's edge proxy closes any
 * synchronous response that sends no data for ~26s ("Inactivity Timeout" →
 * 504), which would kill the step mid-run and leave it stuck as "running".
 * So we return a streamed response and emit a whitespace heartbeat every few
 * seconds while the step works; the final line of the stream is the JSON
 * result. The background sequencer reads the last line to get the outcome.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId || '');
  const stepKey = String(body.stepKey || '') as StepKey;

  if (!jobId || !stepKey) {
    return NextResponse.json({ error: 'jobId e stepKey richiesti' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (s: string) => { if (!closed) { try { controller.enqueue(encoder.encode(s)); } catch { /* ignore */ } } };
      // Keep the connection alive past Netlify's ~26s inactivity limit.
      emit(' ');
      const beat = setInterval(() => emit(' '), 8000);
      const finish = (obj: unknown) => {
        clearInterval(beat);
        emit('\n' + JSON.stringify(obj) + '\n');
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
      };

      try {
        const result = await runOneStep(jobId, stepKey);
        finish(result);
      } catch (e) {
        finish({ ok: false, stepStatus: 'failed', jobStatus: 'failed', error: (e as Error).message?.slice(0, 1000) });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

async function runOneStep(jobId: string, stepKey: StepKey) {
  const { data: job, error } = await supabaseAdmin
    .from('pipeline_jobs')
    .select('id, project_id, input, steps, status')
    .eq('id', jobId)
    .single();

  if (error || !job) throw new Error(`Job non trovato: ${error?.message}`);
  if (job.status === 'canceled') return { ok: false, jobStatus: 'canceled', stepStatus: 'skipped' };
  if (!job.project_id) throw new Error('Job senza project_id');

  const steps = (job.steps as PipelineStepState[]) || [];
  const idx = steps.findIndex((s) => s.key === stepKey);
  if (idx === -1) throw new Error(`Step ${stepKey} non presente nel job`);

  // Mark step running.
  steps[idx] = { ...steps[idx], status: 'running', startedAt: new Date().toISOString(), error: undefined };
  await supabaseAdmin
    .from('pipeline_jobs')
    .update({ status: 'running', current_step: stepKey, steps })
    .eq('id', jobId);

  try {
    const result = await runStep(stepKey, {
      supabase: supabaseAdmin,
      projectId: job.project_id as string,
      input: (job.input as PipelineInput) || { product: '' },
    });

    steps[idx] = {
      ...steps[idx],
      status: 'completed',
      summary: result.summary,
      output: (result.output || '').slice(0, STEP_OUTPUT_PREVIEW_CHARS),
      finishedAt: new Date().toISOString(),
      error: undefined,
    };

    const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
    const jobStatus = allDone ? 'completed' : 'running';

    await supabaseAdmin
      .from('pipeline_jobs')
      .update({ steps, status: jobStatus, current_step: allDone ? null : stepKey })
      .eq('id', jobId);

    return { ok: true, stepStatus: 'completed', jobStatus };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 1000) || 'Errore step';
    steps[idx] = { ...steps[idx], status: 'failed', error: msg, finishedAt: new Date().toISOString() };
    await supabaseAdmin
      .from('pipeline_jobs')
      .update({ steps, status: 'failed', current_step: stepKey, error: msg })
      .eq('id', jobId);
    return { ok: false, stepStatus: 'failed', jobStatus: 'failed', error: msg };
  }
}
