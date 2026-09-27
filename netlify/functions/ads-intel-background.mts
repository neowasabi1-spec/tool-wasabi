import type { Config, Context } from '@netlify/functions';
import { runAdsIntelJob } from '../../src/lib/ads-intel/dispatch';

/**
 * Background runner for ads-intel jobs when ADS_INTEL_INLINE is off.
 * Local autonomy: prefer ADS_INTEL_INLINE=1 with `npm run dev` instead.
 */
export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const body = await req.json().catch(() => ({}));
  const jobId = Number(body.jobId);
  if (!jobId) return new Response(JSON.stringify({ error: 'jobId required' }), { status: 400 });

  // Return 202 immediately; Netlify background continues after response on .mts background naming.
  // For standard function we await — keep short jobs only.
  await runAdsIntelJob(jobId);
  return new Response(JSON.stringify({ ok: true, jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = {
  path: '/.netlify/functions/ads-intel-background',
};
