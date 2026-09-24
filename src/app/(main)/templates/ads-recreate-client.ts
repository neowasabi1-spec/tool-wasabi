'use client';

export function absStreamUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${window.location.origin}/api/projecthub/file-proxy?path=${encodeURIComponent(path)}&stream=1`;
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const timeout = res.status === 504 || res.status === 408 || /timeout/i.test(raw);
    throw new Error(timeout
      ? `Server timed out (${res.status})`
      : `Unexpected response (HTTP ${res.status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jobFrom(data: Record<string, unknown>, fallback?: Record<string, unknown>) {
  return {
    requestId: String(data.requestId || fallback?.requestId || 'job'),
    statusUrl: String(data.statusUrl || fallback?.statusUrl || ''),
    responseUrl: String(data.responseUrl || fallback?.responseUrl || ''),
    modelKey: String(data.modelKey || fallback?.modelKey || 'gpt-image-2-edit'),
  };
}

export async function pollGenerateJob(opts: {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  modelKey: string;
  onWait: (msg: string) => void;
  label?: string;
}): Promise<string> {
  const label = opts.label || 'Generation';
  let data: Record<string, unknown> = {
    status: 'pending',
    requestId: opts.requestId,
    statusUrl: opts.statusUrl,
    responseUrl: opts.responseUrl,
    modelKey: opts.modelKey,
  };
  const started = Date.now();
  const deadline = started + 5 * 60_000;
  let misses = 0;
  while (String(data.status || '') === 'pending') {
    if (Date.now() > deadline) throw new Error(`${label} timed out — keep the popup open and try again`);
    const elapsed = Math.round((Date.now() - started) / 1000);
    opts.onWait(
      String(data.falStatus || '') === 'IN_PROGRESS'
        ? `${label} is generating… ${elapsed}s`
        : `Waiting for ${label}… checking every 5s (${elapsed}s)`,
    );
    await sleep(5_000);
    try {
      const pollRes = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'poll',
          ...jobFrom(data, opts),
        }),
      });
      const next = await readJson(pollRes);
      if (next.status === 'error') {
        const msg = String(next.error || `${label} failed`);
        const transient = pollRes.status === 504 || pollRes.status === 408 || /timeout|ETIMEDOUT|network/i.test(msg);
        if (!transient) throw new Error(msg);
        misses += 1;
        if (misses >= 4) throw new Error(msg);
        continue;
      }
      if (!pollRes.ok) {
        misses += 1;
        if (misses >= 4) throw new Error(`Unexpected response (HTTP ${pollRes.status})`);
        continue;
      }
      misses = 0;
      data = { ...data, ...next };
    } catch (e) {
      misses += 1;
      if (misses >= 4) throw e;
    }
  }
  const url = String(data.url || '').trim();
  if (String(data.status || '') !== 'completed' || !url) {
    throw new Error(String(data.error || `${label} did not return a file`));
  }
  return url;
}

export async function submitAndPollGenerate(opts: {
  mode: string;
  model: string;
  prompt: string;
  imageUrl?: string;
  secondaryImageUrl?: string;
  duration?: number;
  onWait: (msg: string) => void;
  label?: string;
}): Promise<string> {
  const label = opts.label || 'Generation';
  opts.onWait(`Sending to ${label}…`);
  const submitRes = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: opts.mode,
      model: opts.model,
      prompt: opts.prompt,
      size: opts.mode === 'image2image' ? '1024x1536' : '9:16',
      style: 'natural',
      imageUrl: opts.imageUrl,
      secondaryImageUrl: opts.secondaryImageUrl || undefined,
      duration: opts.duration,
    }),
  });
  const submit = await readJson(submitRes);
  if (!submitRes.ok || submit.status === 'error' || !submit.statusUrl) {
    throw new Error(String(submit.error || `${label} failed to start`));
  }
  return pollGenerateJob({ ...jobFrom(submit), onWait: opts.onWait, label });
}

export async function extractVideoPosters(src: string): Promise<string[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  if (!src.startsWith(window.location.origin) && /^https?:\/\//i.test(src)) {
    video.crossOrigin = 'anonymous';
  }
  video.src = src;
  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Video poster timed out')), 20_000);
    video.onloadeddata = () => {
      window.clearTimeout(t);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(t);
      reject(new Error('Could not load the source video'));
    };
  });
  const duration = Number.isFinite(video.duration) && video.duration > 0.4 ? video.duration : 1;
  const stamps = [0.12, 0.5, 0.88].map((t) => Math.min(Math.max(duration * t, 0.04), Math.max(0.08, duration - 0.08)));
  const canvas = document.createElement('canvas');
  const frames: string[] = [];
  for (const t of stamps) {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Seek timed out')), 8_000);
      video.onseeked = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.currentTime = t;
    });
    const w = video.videoWidth || 720;
    const h = video.videoHeight || 1280;
    canvas.width = Math.min(w, 720);
    canvas.height = Math.round((h / w) * canvas.width) || 1280;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL('image/jpeg', 0.72));
  }
  video.removeAttribute('src');
  video.load();
  return frames;
}
