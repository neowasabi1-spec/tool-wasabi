/**
 * Every 10 minutes: kick background Jev relevance scoring for all projects.
 */
export default async () => {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  const secret = process.env.CRON_SECRET || process.env.APIFY_WEBHOOK_SECRET || '';
  if (!base) {
    console.log('[ad-relevance-cron] no site URL env; skipping');
    return;
  }
  try {
    const resp = await fetch(`${base}/.netlify/functions/ad-relevance-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'x-cron-secret': secret } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    console.log('[ad-relevance-cron] kicked', resp.status);
  } catch (e) {
    // Background may keep running after we abort the wait — log and move on.
    console.log('[ad-relevance-cron] kick', e instanceof Error ? e.message : String(e));
  }
};

export const config = { schedule: '*/10 * * * *' };
