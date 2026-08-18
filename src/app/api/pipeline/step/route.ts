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
 * This is the unit of work the background sequencer calls, one step at a
 * time. Keeping each step in its own request means every LLM call runs with
 * a fresh, focused context (high quality) and well within the serverless
 * timeout, while the job row is the single source of truth for progress.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId || '');
  const stepKey = String(body.stepKey || '') as StepKey;

  if (!jobId || !stepKey) {
    return NextResponse.json({ error: 'jobId e stepKey richiesti' }, { status: 400 });
  }

  const { data: job, error } = await supabaseAdmin
    .from('pipeline_jobs')
    .select('id, project_id, input, steps, status')
    .eq('id', jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: `Job non trovato: ${error?.message}` }, { status: 404 });
  }
  if (job.status === 'canceled') {
    return NextResponse.json({ ok: false, jobStatus: 'canceled', stepStatus: 'skipped' });
  }
  if (!job.project_id) {
    return NextResponse.json({ error: 'Job senza project_id' }, { status: 400 });
  }

  const steps = (job.steps as PipelineStepState[]) || [];
  const idx = steps.findIndex((s) => s.key === stepKey);
  if (idx === -1) {
    return NextResponse.json({ error: `Step ${stepKey} non presente nel job` }, { status: 400 });
  }

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
      .update({
        steps,
        status: jobStatus,
        current_step: allDone ? null : stepKey,
      })
      .eq('id', jobId);

    return NextResponse.json({ ok: true, stepStatus: 'completed', jobStatus });
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 1000) || 'Errore step';
    steps[idx] = {
      ...steps[idx],
      status: 'failed',
      error: msg,
      finishedAt: new Date().toISOString(),
    };
    await supabaseAdmin
      .from('pipeline_jobs')
      .update({ steps, status: 'failed', current_step: stepKey, error: msg })
      .eq('id', jobId);

    return NextResponse.json({ ok: false, stepStatus: 'failed', jobStatus: 'failed', error: msg });
  }
}
