/**
 * Background worker for Jev jobs (ingest, templates, families, generate…).
 * Invoked fire-and-forget from enqueue / scheduled drain. Timeout ~15 min.
 */
import type { Config, Context } from '@netlify/functions';
import { runJevJobById } from '../../src/lib/ads-intel/dispatch';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.json().catch(() => ({} as { jobId?: string }));
  const jobId = String(body.jobId || '').trim();
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'jobId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await runJevJobById(jobId);
    return new Response(JSON.stringify({ ok: true, jobId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[jev-jobs-background]', jobId, msg);
    return new Response(JSON.stringify({ ok: false, jobId, error: msg.slice(0, 500) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config: Config = {
  path: '/.netlify/functions/jev-jobs-background',
};
