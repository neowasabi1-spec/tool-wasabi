/**
 * Ads-intel job enqueue + local inline runner.
 * ADS_INTEL_INLINE=1 (or non-production) runs jobs in-process for local autonomy.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
export type AdsIntelJobType = 'extract_ad' | 'analyze_ad' | 'generate_concepts' | 'create_output' | 'sync_meta_ads' | 'ping';

export function adsIntelInline(): boolean {
  const v = (process.env.ADS_INTEL_INLINE || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return process.env.NODE_ENV !== 'production';
}

export async function enqueueAdsIntelJob(opts: {
  projectId: string;
  type: AdsIntelJobType;
  payload?: Record<string, unknown>;
}): Promise<{ jobId: number; ranInline: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('ads_intel_jobs')
    .insert({
      project_id: opts.projectId,
      type: opts.type,
      payload: opts.payload || {},
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Failed to enqueue ads_intel job');
  }

  const jobId = Number(data.id);

  if (adsIntelInline()) {
    void import('./dispatch')
      .then(({ runAdsIntelJob }) => runAdsIntelJob(jobId))
      .catch((e) => {
        console.error('[ads-intel] inline job failed', jobId, e);
      });
    return { jobId, ranInline: true };
  }

  try {
    const origin =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.TOOL_BASE_URL ||
      '';
    if (origin) {
      await fetch(`${origin.replace(/\/$/, '')}/.netlify/functions/ads-intel-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }

  return { jobId, ranInline: false };
}

export async function loadJob(jobId: number): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from('ads_intel_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown>) || null;
}

export async function markProcessing(jobId: number): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from('ads_intel_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['pending', 'processing'])
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const attempts = Number((data as { attempts?: number }).attempts || 0) + 1;
  await supabaseAdmin.from('ads_intel_jobs').update({ attempts }).eq('id', jobId);
  return { ...(data as object), attempts } as Record<string, unknown>;
}

export async function finishJob(
  jobId: number,
  result: { ok: true; result?: unknown } | { ok: false; error: string },
): Promise<void> {
  if (result.ok) {
    await supabaseAdmin
      .from('ads_intel_jobs')
      .update({
        status: 'completed',
        result: result.result ?? {},
        finished_at: new Date().toISOString(),
        error: '',
      })
      .eq('id', jobId);
  } else {
    await supabaseAdmin
      .from('ads_intel_jobs')
      .update({
        status: 'failed',
        error: result.error.slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}

export async function setJobProgress(jobId: number, progress: string): Promise<void> {
  await supabaseAdmin.from('ads_intel_jobs').update({ progress }).eq('id', jobId);
}
