import { createClient } from '@supabase/supabase-js';

/**
 * Background function (up to 15 min) that DRIVES the Project Autopilot
 * pipeline. It does NOT contain any AI logic itself: it simply calls the
 * `/api/pipeline/step` route once per step, in order, updating nothing on
 * its own — the step route is the single writer of job state.
 *
 * Why a background function? The whole pipeline (market research → brief →
 * competitor → ads → landing) can take several minutes, well past the 300s
 * serverless cap of a single request. Each individual step, however, fits
 * comfortably inside that cap, so we sequence them here.
 *
 * Body: { jobId }
 */

// Canonical step order — keep in sync with PIPELINE_STEPS in
// src/lib/pipeline/types.ts.
const STEP_ORDER = ['market_research', 'brief', 'competitor', 'ads', 'landing'];

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  if (!url || !key) throw new Error('Supabase env (URL / SERVICE_ROLE_KEY) missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type SupabaseClient = ReturnType<typeof getSupabase>;

/**
 * Poll the pipeline_jobs row until the given step reaches a terminal state.
 * Returns the step status ('completed' | 'failed' | 'skipped') or null on
 * timeout. The step route is the single writer, so this is authoritative and
 * immune to Netlify cutting the internal HTTP stream.
 */
async function pollStepOutcome(
  supabase: SupabaseClient,
  jobId: string,
  stepKey: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await supabase
      .from('pipeline_jobs')
      .select('status, steps')
      .eq('id', jobId)
      .single();
    if (!data) continue;
    if (data.status === 'canceled') return 'skipped';
    const step = (Array.isArray(data.steps) ? data.steps : []).find(
      (s: { key: string }) => s.key === stepKey,
    ) as { status?: string } | undefined;
    if (step?.status === 'completed' || step?.status === 'failed' || step?.status === 'skipped') {
      return step.status;
    }
  }
  return null;
}

function siteOrigin(req: Request): string {
  const raw =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    new URL(req.url).origin;
  return raw.replace(/\/$/, '');
}

export default async (req: Request) => {
  let jobId = '';
  try {
    const body = await req.json();
    jobId = String(body.jobId || '');
  } catch { /* ignore */ }

  if (!jobId) return new Response('missing jobId', { status: 200 });

  const supabase = getSupabase();
  const origin = siteOrigin(req);

  const log = (...a: unknown[]) => console.log(`[pipeline ${jobId}]`, ...a);

  // Load the job to get the step order + resume point.
  const { data: job, error } = await supabase
    .from('pipeline_jobs')
    .select('id, status, steps')
    .eq('id', jobId)
    .single();

  if (error || !job) {
    log('job not found:', error?.message);
    return new Response('job not found', { status: 200 });
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const orderedKeys: string[] =
    steps.length > 0 ? steps.map((s: { key: string }) => s.key) : STEP_ORDER;

  for (const key of orderedKeys) {
    // Re-check cancellation between steps.
    const { data: fresh } = await supabase
      .from('pipeline_jobs')
      .select('status, steps')
      .eq('id', jobId)
      .single();
    if (fresh?.status === 'canceled') {
      log('canceled — stopping');
      return new Response('canceled', { status: 200 });
    }
    // Skip already-completed steps (resume support).
    const cur = (fresh?.steps || steps).find((s: { key: string }) => s.key === key);
    if (cur?.status === 'completed' || cur?.status === 'skipped') {
      continue;
    }

    log('running step', key);

    // Fire the step. We deliberately DO NOT trust the HTTP response: Netlify
    // cuts internal function-to-function streaming at ~26s (undici throws
    // "terminated"), yet the step route keeps running server-side and is the
    // single writer of job state. So we swallow any fetch/stream error and
    // poll the DB below for the authoritative outcome.
    try {
      const res = await fetch(`${origin}/api/pipeline/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, stepKey: key }),
      });
      await res.text().catch(() => '');
    } catch (e) {
      log('step', key, 'fetch ended early (expected on long steps):', (e as Error).message);
    }

    // Poll the DB until the step settles (completed/failed) or we time out.
    const outcome = await pollStepOutcome(supabase, jobId, key, 300000);
    log('step', key, '→', outcome ?? 'timeout');

    if (outcome === 'completed' || outcome === 'skipped') {
      continue;
    }

    // failed or timed out → stop the pipeline.
    if (outcome !== 'failed') {
      await supabase
        .from('pipeline_jobs')
        .update({ status: 'failed', current_step: key, error: `Step ${key}: timeout (nessun esito dopo 5 min)` })
        .eq('id', jobId);
    }
    log('stopping — step did not complete:', outcome ?? 'timeout');
    return new Response('failed', { status: 200 });
  }

  log('done');
  return new Response('done', { status: 200 });
};
