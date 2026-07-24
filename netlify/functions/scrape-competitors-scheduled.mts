/**
 * Daily competitor scrape trigger.
 *
 * Runs on a schedule (production deploys only) and simply pings the app's
 * internal cron endpoint, which finds brands whose scrape is due and starts
 * an Apify run for each. All heavy work (download/insert/transcribe) happens
 * later in /api/apify/webhook, so this stays well under the 30s limit.
 */

export default async () => {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  if (!base) {
    console.log('[scrape-cron] no site URL env; skipping');
    return;
  }
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : '';
  try {
    const resp = await fetch(`${base}/api/apify/cron${qs}`, {
      method: 'POST',
      headers: secret ? { 'x-cron-secret': secret } : {},
    });
    const json = await resp.json().catch(() => ({}));
    console.log('[scrape-cron] triggered', resp.status, JSON.stringify(json));
  } catch (e) {
    console.log('[scrape-cron] error', e instanceof Error ? e.message : String(e));
  }
};

export const config = { schedule: '@daily' };
