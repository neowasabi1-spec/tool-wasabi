/**
 * Background worker: score unscored competitor ads with Jev across all projects.
 */
import type { Config, Context } from '@netlify/functions';
import { scoreAllProjectsUnscoredAds } from '../../src/lib/ads-intel/ad-relevance';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const expected = (process.env.CRON_SECRET || process.env.APIFY_WEBHOOK_SECRET || '').trim();
  const provided = req.headers.get('x-cron-secret') || '';
  if (expected && provided !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await scoreAllProjectsUnscoredAds({
      perProjectLimit: 40,
      maxProjects: 30,
      maxAds: 150,
    });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ad-relevance-background]', msg);
    return new Response(JSON.stringify({ ok: false, error: msg.slice(0, 500) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: '/.netlify/functions/ad-relevance-background',
};
