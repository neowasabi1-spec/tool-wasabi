/**
 * ChatGPT Image 2 as used by the rest of the app.
 *
 * The working UI (Visual HTML editor → /api/generate-image) does NOT call
 * api.openai.com with OPENAI_API_KEY. It submits to
 *   queue.fal.run/openai/gpt-image-2
 *   queue.fal.run/openai/gpt-image-2/edit
 * authenticated with FAL_KEY. That is the ChatGPT Image 2 the product already
 * uses. OPENAI_API_KEY is a different credential (chat/TTS) and 401s here.
 */

export function openaiImageKey(): string {
  return (process.env.OPENAI_API_KEY || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function imageQueueKey(): string {
  return (process.env.FAL_KEY || process.env.FAL_AI_API_KEY || '').trim();
}

export function openaiImageModel(): string {
  return 'gpt-image-2';
}

function mapSize(raw?: string): string {
  const s = (raw || '').trim();
  if (/^\d+x\d+$/i.test(s)) return s;
  const k = s.toLowerCase();
  if (k === 'auto') return 'auto';
  if (k.includes('portrait')) return '1024x1536';
  if (k.includes('16_9') || k.includes('16:9')) return '1536x1024';
  if (k.includes('landscape')) return '1536x1024';
  return '1024x1024';
}

function mapQuality(raw?: string): 'low' | 'medium' | 'high' {
  const k = (raw || '').toLowerCase();
  if (k === 'low' || k === 'high') return k;
  return 'medium';
}

function sizeToFal(size: string): string {
  if (size === '1024x1536' || /portrait/.test(size)) return 'portrait_16_9';
  if (size === '1536x1024' || /landscape|16_9|16:9/.test(size)) return 'landscape_16_9';
  return 'auto';
}

let lastImageErr = '';

export function lastImageGenError(): string {
  return lastImageErr;
}

function redactSecrets(msg: string): string {
  return String(msg || '')
    .replace(/sk-[a-zA-Z0-9_\-]{8,}/g, 'sk-…')
    .replace(/Incorrect API key provided:[^"]*/gi, 'OpenAI rejected the configured API key');
}

function setImageErr(msg: string): void {
  lastImageErr = redactSecrets(msg).slice(0, 500);
  if (lastImageErr) console.warn('[openai-image]', lastImageErr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sniffImage(buf: Buffer, hinted = ''): { mime: string; ext: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (
    buf.length > 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  const h = hinted.toLowerCase();
  if (h.includes('png')) return { mime: 'image/png', ext: 'png' };
  if (h.includes('webp')) return { mime: 'image/webp', ext: 'webp' };
  if (h.includes('jpeg') || h.includes('jpg')) return { mime: 'image/jpeg', ext: 'jpg' };
  return { mime: 'image/png', ext: 'png' };
}

async function bytesFromRef(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 100) return null;
      return { buf, mime: m[1] || 'image/png' };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
    return { buf, mime };
  } catch {
    return null;
  }
}

async function toCompactDataUri(buf: Buffer, mime: string): Promise<string> {
  const sniffed = sniffImage(buf, mime);
  // Competitor Ads remake sends the original still. JPEG-compressing graphic ads
  // makes ChatGPT Image 2 return empty "generation failed".
  if (buf.length <= 2_500_000) {
    return `data:${sniffed.mime};base64,${buf.toString('base64')}`;
  }
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buf)
      .rotate()
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return `data:${sniffed.mime};base64,${buf.toString('base64')}`;
  }
}

export type GptImage2Job = { statusUrl: string; responseUrl: string };

export type GptImage2Poll =
  | { status: 'pending'; falStatus?: string }
  | { status: 'completed'; buf: Buffer; mime: string }
  | { status: 'error'; error: string };

function isFalQueueUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'fal.run'
      || host.endsWith('.fal.run')
      || host === 'fal.ai'
      || host.endsWith('.fal.ai')
    );
  } catch {
    return false;
  }
}

function firstFalImageUrl(result: unknown): { url: string; mime: string } | null {
  const r = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  const pick = (item: unknown): { url: string; mime: string } | null => {
    if (typeof item === 'string' && (/^https?:\/\//i.test(item) || item.startsWith('data:'))) {
      return { url: item, mime: 'image/png' };
    }
    if (!item || typeof item !== 'object') return null;
    const x = item as Record<string, unknown>;
    const url = String(x.url || x.file_url || '').trim();
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) {
      return { url, mime: String(x.content_type || x.mime || 'image/png') };
    }
    return null;
  };
  const arrays = [r.images, r.image, (r.data as Record<string, unknown> | undefined)?.images];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      const found = pick(arr[0]);
      if (found) return found;
    } else {
      const found = pick(arr);
      if (found) return found;
    }
  }
  return pick(r);
}

async function refsToImageUrls(refs: string[]): Promise<string[]> {
  const imageUrls: string[] = [];
  for (const ref of refs.slice(0, 8)) {
    if (ref.startsWith('data:')) {
      const raw = await bytesFromRef(ref);
      if (!raw) continue;
      imageUrls.push(await toCompactDataUri(raw.buf, raw.mime));
      continue;
    }
    const raw = await bytesFromRef(ref);
    if (!raw) continue;
    imageUrls.push(await toCompactDataUri(raw.buf, raw.mime));
  }
  return imageUrls;
}

export async function submitGptImage2Job(opts: {
  prompt: string;
  imageUrls?: string[];
  size?: string;
  quality?: string;
}): Promise<GptImage2Job | null> {
  lastImageErr = '';
  const key = imageQueueKey();
  if (!key) {
    setImageErr('FAL_KEY missing. ChatGPT Image 2 in this app is the same as /api/generate-image (openai/gpt-image-2), not OPENAI_API_KEY.');
    return null;
  }
  const prompt = (opts.prompt || '').trim();
  if (!prompt) {
    setImageErr('empty image prompt');
    return null;
  }
  const refs = (opts.imageUrls || []).filter(Boolean);
  const imageUrls = await refsToImageUrls(refs);
  if (refs.length && !imageUrls.length) {
    setImageErr('Could not load the source images for ChatGPT Image 2');
    return null;
  }

  const endpoint = imageUrls.length ? 'openai/gpt-image-2/edit' : 'openai/gpt-image-2';
  const input: Record<string, unknown> = {
    prompt: prompt.slice(0, 4_000),
    quality: mapQuality(opts.quality),
    num_images: 1,
    output_format: 'png',
  };
  if (imageUrls.length) {
    input.image_urls = imageUrls;
    input.image_size = 'auto';
  } else {
    input.image_size = sizeToFal(mapSize(opts.size));
  }

  try {
    const submit = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    });
    if (!submit.ok) {
      setImageErr(`ChatGPT Image 2 (${endpoint}) ${submit.status}: ${redactSecrets(await submit.text()).slice(0, 280)}`);
      return null;
    }
    const job = await submit.json() as Record<string, unknown>;
    const statusUrl = String(job.status_url || job.statusUrl || '').trim();
    const responseUrl = String(job.response_url || job.responseUrl || '').trim();
    if (!statusUrl || !responseUrl) {
      setImageErr('ChatGPT Image 2 did not return a job');
      return null;
    }
    return { statusUrl, responseUrl };
  } catch (e) {
    setImageErr(`ChatGPT Image 2: ${(e as Error).message}`);
    return null;
  }
}

export async function pollGptImage2Job(job: GptImage2Job): Promise<GptImage2Poll> {
  const key = imageQueueKey();
  if (!key) return { status: 'error', error: 'FAL_KEY missing' };
  if (!isFalQueueUrl(job.statusUrl) || !isFalQueueUrl(job.responseUrl)) {
    return { status: 'error', error: 'Invalid ChatGPT Image 2 job' };
  }
  try {
    const statusUrl = job.statusUrl.includes('?') ? `${job.statusUrl}&logs=1` : `${job.statusUrl}?logs=1`;
    const st = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!st.ok) return { status: 'pending' };
    const status = await st.json() as {
      status?: string;
      error?: string;
      error_type?: string;
      logs?: Array<{ message?: string }>;
    };
    if (status.status === 'COMPLETED') {
      const result = await fetch(job.responseUrl, {
        headers: { Authorization: `Key ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(45_000),
      }).then((r) => r.json());
      const image = firstFalImageUrl(result);
      if (!image) return { status: 'error', error: 'ChatGPT Image 2 returned no image' };
      const raw = await bytesFromRef(image.url);
      if (!raw) return { status: 'error', error: 'Could not download the generated image' };
      const sniffed = sniffImage(raw.buf, image.mime || raw.mime);
      return { status: 'completed', buf: raw.buf, mime: sniffed.mime };
    }
    if (status.status === 'ERROR') {
      let extra = '';
      try {
        const failed = await fetch(job.responseUrl, {
          headers: { Authorization: `Key ${key}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(20_000),
        });
        extra = redactSecrets((await failed.text()).slice(0, 220));
      } catch { /* ignore */ }
      const logLine = (status.logs || []).map((l) => l.message).filter(Boolean).slice(-3).join(' | ');
      const detail = status.error || status.error_type || 'generation failed';
      return {
        status: 'error',
        error: `ChatGPT Image 2 is still the model — wait finished with: ${detail}${logLine ? ` — ${logLine}` : ''}${extra ? ` — ${extra}` : ''}`,
      };
    }
    return { status: 'pending', falStatus: status.status };
  } catch (e) {
    return { status: 'error', error: `ChatGPT Image 2: ${(e as Error).message}` };
  }
}

async function gptImage2ViaGenerateImageQueue(
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
  timeoutMs: number,
): Promise<{ buf: Buffer; mime: string } | null> {
  const job = await submitGptImage2Job({ prompt, imageUrls: refs, size, quality });
  if (!job) return null;
  const deadline = Date.now() + Math.max(20_000, timeoutMs - 5_000);
  while (Date.now() < deadline) {
    await sleep(1_500);
    const polled = await pollGptImage2Job(job);
    if (polled.status === 'completed') return { buf: polled.buf, mime: polled.mime };
    if (polled.status === 'error') {
      setImageErr(polled.error);
      return null;
    }
  }
  setImageErr('ChatGPT Image 2 timed out — the model was still generating');
  return null;
}

export async function waitGptImage2Job(job: GptImage2Job, timeoutMs: number): Promise<GptImage2Poll> {
  const deadline = Date.now() + Math.max(8_000, timeoutMs);
  let last: GptImage2Poll = { status: 'pending' };
  while (Date.now() < deadline) {
    last = await pollGptImage2Job(job);
    if (last.status !== 'pending') return last;
    await sleep(1_500);
  }
  return last;
}

export async function openaiGenerateImageBytes(opts: {
  prompt: string;
  imageUrls?: string[];
  size?: string;
  quality?: string;
  timeoutMs?: number;
  onTick?: () => Promise<void>;
  openaiOnly?: boolean;
}): Promise<{ buf: Buffer; mime: string } | null> {
  lastImageErr = '';
  const prompt = (opts.prompt || '').trim();
  if (!prompt) {
    setImageErr('empty image prompt');
    return null;
  }
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const size = mapSize(opts.size);
  const quality = mapQuality(opts.quality);
  const tick = opts.onTick;
  const iv = tick ? setInterval(() => { void tick(); }, 8_000) : null;
  try {
    const refs = (opts.imageUrls || []).filter(Boolean).slice(0, 16);
    return await gptImage2ViaGenerateImageQueue(prompt, refs, size, quality, timeoutMs);
  } catch (e) {
    setImageErr((e as Error).message);
    return null;
  } finally {
    if (iv) clearInterval(iv);
  }
}

/** Text-to-image, or image-to-image when imageUrls is set. ChatGPT Image 2. */
export async function openaiGenerateImage(opts: {
  prompt: string;
  imageUrls?: string[];
  size?: string;
  quality?: string;
  timeoutMs?: number;
  onTick?: () => Promise<void>;
  openaiOnly?: boolean;
}): Promise<string | null> {
  const bytes = await openaiGenerateImageBytes(opts);
  if (!bytes) return null;
  return `data:${bytes.mime};base64,${bytes.buf.toString('base64')}`;
}
