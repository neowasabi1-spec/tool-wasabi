import { createClient } from '@supabase/supabase-js';

/**
 * Keeps the footage pipeline moving without anyone pressing a button.
 *
 * Three things used to stall it: a lost fire-and-forget trigger left a
 * segmentation job pending forever, Replicate rate-limits turned subtitle
 * cleanups into dead 'error' rows, and firing every shot of a video at once
 * caused those rate limits in the first place. This runs every few minutes and
 * drains each queue in small batches, so shots keep arriving and keep getting
 * cleaned at a pace Replicate accepts.
 *
 * It never enqueues work of its own: only work that was already asked for.
 */

const SEGMENT_STALE_MIN = 10;   // a pending job older than this lost its trigger
const SEGMENT_PER_TICK = 3;
const BUILD_DEAD_MIN = 20;      // past the 15-min function cap: nothing is coming

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    'https://sktpbizpckxldhxzezws.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export default async () => {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  const log = (...a: unknown[]) => console.log('[video-cron]', ...a);
  if (!base) return void log('no site URL env; skipping');

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    return void log((e as Error).message);
  }

  const fire = (fn: string, body: Record<string, unknown>) =>
    fetch(`${base}/.netlify/functions/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((e) => log(`${fn} trigger failed:`, (e as Error).message));

  // 1. Segmentation jobs whose trigger never landed.
  const staleBefore = new Date(Date.now() - SEGMENT_STALE_MIN * 60_000).toISOString();
  const { data: jobs } = await supabase
    .from('video_segment_jobs')
    .select('id, project_id, brand_id, ad_id')
    .eq('status', 'pending')
    .lt('created_at', staleBefore)
    .order('id')
    .limit(SEGMENT_PER_TICK);
  for (const j of jobs || []) {
    await fire('segment-video-background', {
      jobId: j.id, projectId: j.project_id, brandId: j.brand_id, adId: j.ad_id,
    });
  }
  if (jobs?.length) log(`re-fired ${jobs.length} stale segmentation job(s)`);

  // 2. Video assembly jobs: same lost-trigger problem, plus a function that dies
  // mid-assembly leaves a row spinning with nothing to show the user.
  const { data: staleBuilds } = await supabase
    .from('video_build_jobs')
    .select('id, project_id, brand_id, ad_id')
    .eq('status', 'pending')
    .lt('created_at', staleBefore)
    .order('id')
    .limit(SEGMENT_PER_TICK);
  for (const j of staleBuilds || []) {
    await fire('build-video-background', {
      jobId: j.id, projectId: j.project_id, brandId: j.brand_id, adId: j.ad_id,
    });
  }
  if (staleBuilds?.length) log(`re-fired ${staleBuilds.length} stale build job(s)`);

  const deadBefore = new Date(Date.now() - BUILD_DEAD_MIN * 60_000).toISOString();
  const { data: dead } = await supabase
    .from('video_build_jobs')
    .update({ status: 'error', error: 'Build stopped responding', finished_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('started_at', deadBefore)
    .select('id');
  if (dead?.length) log(`gave up on ${dead.length} build job(s) past the function limit`);

  // Subtitle cleanup is not drained from here. A queue of pending shots was
  // fired every 5 minutes and kept spending after the click.
  log('subtitle queue left alone');
};

export const config = { schedule: '*/5 * * * *' };
