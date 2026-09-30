import type { Context } from '@netlify/functions';
import { runRemakeJob } from '../../src/lib/remake-still';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({} as { projectId?: string; jobId?: string }));
  const projectId = String(body.projectId || '').trim();
  const jobId = String(body.jobId || '').trim();
  if (!projectId || !jobId) return new Response('missing job', { status: 400 });
  try {
    await runRemakeJob(projectId, jobId);
  } catch (e) {
    console.error('[remake-image-background]', (e as Error).message);
  }
  return new Response('ok');
};
