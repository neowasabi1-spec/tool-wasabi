import type { Context } from '@netlify/functions';
import { runGenerateImageJob } from '../../src/lib/generate-image-job';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({} as { jobId?: string }));
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return new Response('missing job', { status: 400 });
  try {
    await runGenerateImageJob(jobId);
  } catch (e) {
    console.error('[generate-image-background]', (e as Error).message);
  }
  return new Response('ok');
};
