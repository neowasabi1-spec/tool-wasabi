/**
 * Drain queued Jev jobs every few minutes. Only kicks the background worker
 * (does not run AI inline — scheduled timeout is ~30s).
 */
import type { Config } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

export default async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  const secret = process.env.CRON_SECRET || process.env.APIFY_WEBHOOK_SECRET || '';

  if (!url || !key || !base) {
    console.log('[jev-cron] missing supabase/url env; skip');
    return;
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: jobs, error } = await sb
    .from('jev_jobs')
    .select('id, type')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(8);

  if (error) {
    console.log('[jev-cron] query error', error.message);
    return;
  }
  if (!jobs?.length) {
    console.log('[jev-cron] idle');
    return;
  }

  for (const j of jobs) {
    try {
      const resp = await fetch(`${base}/.netlify/functions/jev-jobs-background`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-cron-secret': secret } : {}),
        },
        body: JSON.stringify({ jobId: j.id }),
        signal: AbortSignal.timeout(8_000),
      });
      console.log('[jev-cron] kicked', j.type, j.id, resp.status);
    } catch (e) {
      console.log('[jev-cron] kick failed', j.id, e instanceof Error ? e.message : e);
    }
  }
};

export const config: Config = {
  schedule: '*/2 * * * *',
};
