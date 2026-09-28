/** Browser helpers for Ads Creative → Jev API (safe JSON + client-side job wait). */

export async function readApiJson(res: Response): Promise<any> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Empty response (${res.status})`);
  if (trimmed.startsWith('<')) {
    const timedOut = res.status === 502 || res.status === 504 || /gateway|timeout/i.test(trimmed);
    throw new Error(
      timedOut
        ? `Server timed out (${res.status}). The job may still be running in the background — wait a minute and refresh.`
        : `Server returned HTML instead of JSON (${res.status}). Try again.`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${trimmed.slice(0, 120)}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type JobRow = {
  id: string;
  status?: string;
  error?: string | null;
  progress?: string | null;
  result?: unknown;
};

/**
 * Enqueue a Jev job and poll from the browser until done.
 * Avoids wait:true on the Next handler (Netlify returns HTML 504 on long AI jobs).
 */
export async function runJevAndWait(
  projectId: string,
  body: { type: string; payload?: Record<string, unknown> },
  opts?: { onProgress?: (text: string) => void; timeoutMs?: number },
): Promise<JobRow & { jobId: string }> {
  const res = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, wait: false }),
  });
  const data = await readApiJson(res);
  if (!res.ok || data.status === 'error') {
    throw new Error(data.error || `Enqueue failed (${res.status})`);
  }

  const jobId = String(data.jobId || '');
  if (!jobId) throw new Error('No jobId returned');

  if (data.status === 'done') return { jobId, ...data };
  if (data.status === 'error') throw new Error(data.error || 'Job failed');

  const deadline = Date.now() + (opts?.timeoutMs ?? 12 * 60_000);
  let lastProgress = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    const poll = await fetch(`/api/projecthub/projects/${projectId}/ads-creative/jev`);
    const state = await readApiJson(poll);
    if (!poll.ok) throw new Error(state.error || `Poll failed (${poll.status})`);
    const job = ((state.jobs || []) as JobRow[]).find((j) => j.id === jobId);
    if (!job) continue;
    const prog = String(job.progress || '');
    if (prog && prog !== lastProgress) {
      lastProgress = prog;
      opts?.onProgress?.(prog);
    }
    if (job.status === 'done') return { jobId, ...job };
    if (job.status === 'error' || job.status === 'cancelled') {
      throw new Error(job.error || `Job ${job.status}`);
    }
  }
  throw new Error('Timed out waiting for the job. It may still finish — refresh in a minute.');
}
