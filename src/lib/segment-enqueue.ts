/**
 * Shared logic to enqueue a "split video into shots" job and fire the Netlify
 * background function that does the ffmpeg work. Used by the manual segment API
 * route AND by auto-split triggers (My Footage upload, competitor scrape,
 * extension save) so a video starts splitting the moment it lands.
 */
import { supabaseAdmin } from '@/lib/supabase-admin';

/** Best base URL to reach our own Netlify background functions from server code. */
export function backgroundOrigin(reqOrigin?: string): string {
  const raw =
    reqOrigin ||
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

export async function triggerSegmentBackground(
  origin: string,
  payload: { jobId: number; projectId: string; brandId: number; adId: number },
): Promise<void> {
  try {
    await fetch(`${origin}/.netlify/functions/segment-video-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[segment] background trigger failed:', (e as Error).message);
  }
}

/**
 * Enqueue segmentation for a video creative (idempotent per ad). Skips if a job
 * is already pending/processing (re-firing the background trigger for a pending
 * one in case the original fire was lost).
 */
export async function enqueueSegmentation(opts: {
  projectId: string;
  brandId: number;
  adId: number;
  origin?: string;
}): Promise<{ jobId: number | null; queued: boolean }> {
  const { projectId, brandId, adId } = opts;
  const origin = backgroundOrigin(opts.origin);

  const { data: active } = await supabaseAdmin
    .from('video_segment_jobs')
    .select('id, status')
    .eq('ad_id', adId)
    .in('status', ['pending', 'processing'])
    .maybeSingle();
  if (active?.id) {
    if (active.status === 'pending') {
      await triggerSegmentBackground(origin, { jobId: active.id, projectId, brandId, adId });
    }
    return { jobId: active.id as number, queued: false };
  }

  const { data: job, error } = await supabaseAdmin
    .from('video_segment_jobs')
    .insert({ project_id: projectId, brand_id: brandId, ad_id: adId, status: 'pending' })
    .select('id')
    .single();
  if (error || !job) {
    console.warn('[segment] enqueue failed:', error?.message);
    return { jobId: null, queued: false };
  }

  await triggerSegmentBackground(origin, { jobId: job.id as number, projectId, brandId, adId });
  return { jobId: job.id as number, queued: true };
}

/** Fire-and-forget auto-split; never throws (used after inserting a video ad). */
export async function autoSplitIfVideo(opts: {
  projectId: string;
  brandId: number;
  adId: number;
  mediaType?: string;
  filePath?: string;
  origin?: string;
}): Promise<void> {
  try {
    if (opts.mediaType !== 'video') return;
    if (!opts.filePath) return;
    await enqueueSegmentation({
      projectId: opts.projectId,
      brandId: opts.brandId,
      adId: opts.adId,
      origin: opts.origin,
    });
  } catch (e) {
    console.warn('[segment] autoSplit failed:', (e as Error).message);
  }
}
