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
    let stepStatus = 'failed';
    try {
      const res = await fetch(`${origin}/api/pipeline/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, stepKey: key }),
      });
      const data = await res.json().catch(() => ({}));
      stepStatus = data?.stepStatus || (res.ok ? 'completed' : 'failed');
      log('step', key, '→', stepStatus);
    } catch (e) {
      log('step', key, 'request failed:', (e as Error).message);
      // Mark the job failed so the UI doesn't spin forever.
      await supabase
        .from('pipeline_jobs')
        .update({ status: 'failed', error: `Step ${key}: ${(e as Error).message}`.slice(0, 1000) })
        .eq('id', jobId);
      return new Response('step request failed', { status: 200 });
    }

    if (stepStatus === 'failed') {
      log('stopping — step failed');
      return new Response('failed', { status: 200 });
    }
  }

  log('done');
  return new Response('done', { status: 200 });
};
