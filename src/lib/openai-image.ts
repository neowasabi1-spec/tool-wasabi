/**
 * ChatGPT Images (gpt-image-2) via the official OpenAI SDK.
 * Fal is retired — do not route image gen through fal.ai.
 */

import OpenAI, { toFile } from 'openai';

export function openaiImageKey(): string {
  return (process.env.OPENAI_API_KEY || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

export function openaiImageModel(): string {
  const raw = (process.env.PIPELINE_IMAGE_MODEL || 'gpt-image-2').trim();
  const name = raw.replace(/^openai\//i, '').replace(/\/edit$/i, '');
  if (!name || name.includes('/')) return 'gpt-image-2';
  return name;
}

function openaiBaseUrl(): string | undefined {
  const raw = (process.env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, '');
  return raw || undefined;
}

function openaiClient(apiKey: string): OpenAI {
  const baseURL = openaiBaseUrl();
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
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

function bytesFromSdk(data: Array<{ b64_json?: string | null; url?: string | null }> | undefined): Promise<{ buf: Buffer; mime: string } | null> {
  const row = data?.[0];
  if (!row) return Promise.resolve(null);
  if (row.b64_json) {
    const buf = Buffer.from(String(row.b64_json).replace(/\s/g, ''), 'base64');
    if (buf.length < 80) return Promise.resolve(null);
    return Promise.resolve({ buf, mime: 'image/png' });
  }
  if (row.url) return bytesFromRef(row.url);
  return Promise.resolve(null);
}

function supportsInputFidelity(model: string): boolean {
  return /gpt-image-1(\.5)?/i.test(model) && !/mini/i.test(model);
}

async function openaiEdit(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
): Promise<{ buf: Buffer; mime: string } | null> {
  const files = [];
  for (let i = 0; i < refs.length; i++) {
    const raw = await bytesFromRef(refs[i]);
    if (!raw) continue;
    const { mime, ext } = sniffImage(raw.buf, raw.mime);
    files.push(await toFile(raw.buf, `ref-${i}.${ext}`, { type: mime }));
  }
  if (!files.length) {
    setImageErr('Could not download the source image for ChatGPT Image 2');
    return null;
  }

  const client = openaiClient(key);
  const extra: { input_fidelity?: 'high' } = {};
  if (supportsInputFidelity(model)) extra.input_fidelity = 'high';

  try {
    const result = await client.images.edit({
      model,
      image: files.length === 1 ? files[0] : files,
      prompt: prompt.slice(0, 32_000),
      n: 1,
      ...(size && size !== 'auto' ? { size: size as '1024x1024' } : {}),
      quality,
      ...extra,
    });
    return bytesFromSdk(result.data);
  } catch (e) {
    setImageErr(`ChatGPT Image 2 edit: ${(e as Error).message}`);
    return null;
  }
}

async function openaiGenerateOnce(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
): Promise<{ buf: Buffer; mime: string } | null> {
  if (refs.length) return openaiEdit(key, model, prompt, refs, size, quality);
  const client = openaiClient(key);
  try {
    const result = await client.images.generate({
      model,
      prompt: prompt.slice(0, 32_000),
      n: 1,
      ...(size && size !== 'auto' ? { size: size as '1024x1024' } : {}),
      quality,
    });
    return bytesFromSdk(result.data);
  } catch (e) {
    setImageErr(`ChatGPT Image 2: ${(e as Error).message}`);
    return null;
  }
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
    const openaiKey = openaiImageKey();
    if (!openaiKey) {
      setImageErr('OPENAI_API_KEY missing');
      return null;
    }
    const models = Array.from(new Set([openaiImageModel(), 'gpt-image-2'].filter(Boolean)));
    const work = async () => {
      for (const model of models) {
        try {
          const bytes = await openaiGenerateOnce(openaiKey, model, prompt, refs, size, quality);
          if (bytes) return bytes;
        } catch (e) {
          setImageErr(`${model}: ${(e as Error).message}`);
        }
      }
      return null;
    };
    const raced = await Promise.race([
      work(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          setImageErr('ChatGPT Image 2 timed out');
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (raced) return raced;
    if (!lastImageErr) setImageErr('ChatGPT Image 2 returned empty');
    return null;
  } catch (e) {
    setImageErr((e as Error).message);
    return null;
  } finally {
    if (iv) clearInterval(iv);
  }
}

/** Text-to-image, or image-to-image when imageUrls is set. ChatGPT Images only (gpt-image-2). */
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
