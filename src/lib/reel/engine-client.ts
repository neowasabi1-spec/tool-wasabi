/**
 * Wasabi → Claude Cloud reel engine HTTP client.
 * Mediabuyers never talk to MCP; Netlify proxies here.
 */

export type ReelEngineJob = {
  id: string;
  kind: string;
  status: string;
  mediaBuyer: string;
  projectId: string;
  brandId?: number;
  brief?: string;
  slug?: string;
  reelDir?: string;
  progress?: string;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

function engineConfig(): { base: string; secret: string } | null {
  const base = (process.env.REEL_ENGINE_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;
  const secret = (process.env.REEL_ENGINE_SECRET || '').trim();
  return { base, secret };
}

export function isReelEngineConfigured(): boolean {
  return !!engineConfig();
}

async function engineFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const cfg = engineConfig();
  if (!cfg) throw new Error('REEL_ENGINE_URL is not configured on Wasabi');
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (cfg.secret) {
    headers.set('Authorization', `Bearer ${cfg.secret}`);
    headers.set('x-reel-engine-secret', cfg.secret);
  }
  const res = await fetch(`${cfg.base}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  return res;
}

export async function engineHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await engineFetch('/health');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function engineCreateJob(input: {
  kind?: 'import' | 'produce' | 'publish';
  mediaBuyer: string;
  projectId: string;
  brandId?: number;
  brief?: string;
  slug?: string;
  name?: string;
  includeFullAds?: boolean;
}): Promise<ReelEngineJob> {
  const res = await engineFetch('/jobs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'produce', ...input }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    job?: ReelEngineJob;
    error?: string;
  };
  if (!res.ok || !data.job) {
    throw new Error(data.error || `Engine create failed (${res.status})`);
  }
  return data.job;
}

export async function engineGetJob(jobId: string): Promise<ReelEngineJob> {
  const res = await engineFetch(`/jobs/${encodeURIComponent(jobId)}`);
  const data = (await res.json().catch(() => ({}))) as {
    job?: ReelEngineJob;
    error?: string;
  };
  if (!res.ok || !data.job) {
    throw new Error(data.error || `Engine get failed (${res.status})`);
  }
  return data.job;
}

export async function engineListJobs(opts: {
  projectId: string;
  mediaBuyer?: string;
  limit?: number;
}): Promise<ReelEngineJob[]> {
  const q = new URLSearchParams({ projectId: opts.projectId });
  if (opts.mediaBuyer) q.set('mediaBuyer', opts.mediaBuyer);
  if (opts.limit) q.set('limit', String(opts.limit));
  const res = await engineFetch(`/jobs?${q}`);
  const data = (await res.json().catch(() => ({}))) as {
    jobs?: ReelEngineJob[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `Engine list failed (${res.status})`);
  return data.jobs || [];
}

/** Stable folder slug for a Wasabi user (media buyer). */
export function mediaBuyerSlugFromUser(user: {
  id?: string | null;
  email?: string | null;
  name?: string | null;
}): string {
  const emailLocal = (user.email || '').split('@')[0]?.trim();
  const raw =
    emailLocal ||
    (user.name || '').trim() ||
    (user.id ? `u-${user.id.replace(/-/g, '').slice(0, 12)}` : 'anonymous');
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'anonymous';
}
