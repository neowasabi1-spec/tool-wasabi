/**
 * ChatGPT image generation via the OpenAI Images API (not fal).
 * Model: gpt-image-2 (override with PIPELINE_IMAGE_MODEL).
 */

export function openaiImageKey(): string {
  return (process.env.OPENAI_API_KEY || '').trim();
}

export function openaiImageModel(): string {
  const raw = (process.env.PIPELINE_IMAGE_MODEL || 'gpt-image-2').trim();
  const name = raw.replace(/^openai\//i, '').replace(/\/edit$/i, '');
  if (!name || name.includes('/')) return 'gpt-image-2';
  return name;
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

function setImageErr(msg: string): void {
  lastImageErr = String(msg || '').slice(0, 500);
  if (lastImageErr) console.warn('[openai-image]', lastImageErr);
}

function parseResultBytes(json: unknown): { buf: Buffer; mime: string } | null {
  const row = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0];
  if (!row) return null;
  if (row.b64_json) {
    const buf = Buffer.from(String(row.b64_json).replace(/\s/g, ''), 'base64');
    if (buf.length < 80) return null;
    return { buf, mime: 'image/png' };
  }
  return null;
}

function parseResult(json: unknown): string | null {
  const bytes = parseResultBytes(json);
  if (bytes) return `data:${bytes.mime};base64,${bytes.buf.toString('base64')}`;
  const row = (json as { data?: Array<{ url?: string }> })?.data?.[0];
  return row?.url || null;
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

function supportsInputFidelity(model: string): boolean {
  // gpt-image-2 rejects this field (always high fidelity). Only 1 / 1.5 accept it.
  return /gpt-image-1(\.5)?/i.test(model) && !/mini/i.test(model);
}

async function openaiEdit(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
  timeoutMs: number,
): Promise<{ buf: Buffer; mime: string } | null> {
  const files: Array<{ buf: Buffer; mime: string; name: string }> = [];
  for (let i = 0; i < refs.length; i++) {
    const raw = await bytesFromRef(refs[i]);
    if (!raw) continue;
    const { mime, ext } = sniffImage(raw.buf, raw.mime);
    files.push({
      buf: raw.buf,
      mime,
      name: `ref-${i}.${ext}`,
    });
  }
  if (!files.length) {
    setImageErr('Could not download the source image for ChatGPT edit');
    return null;
  }

  const post = async (field: 'image[]' | 'image', extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt.slice(0, 32_000));
    form.append('n', '1');
    if (size && size !== 'auto') form.append('size', size);
    if (quality) form.append('quality', quality);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    for (const file of files) {
      form.append(field, new Blob([new Uint8Array(file.buf)], { type: file.mime }), file.name);
    }
    return fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const extra: Record<string, string> = {};
  if (supportsInputFidelity(model)) extra.input_fidelity = 'high';

  let mp = await post('image[]', extra);
  if (!mp.ok) {
    const err = await mp.text();
    setImageErr(`OpenAI edit ${mp.status}: ${err.slice(0, 280)}`);
    return null;
  }
  if (!mp.ok) return null;
  const json = await mp.json();
  const bytes = parseResultBytes(json);
  if (bytes) return bytes;
  const url = (json as { data?: Array<{ url?: string }> })?.data?.[0]?.url;
  if (!url) return null;
  const dl = await bytesFromRef(url);
  if (!dl) return null;
  const sniffed = sniffImage(dl.buf, dl.mime);
  return { buf: dl.buf, mime: sniffed.mime };
}

async function openaiGenerateOnce(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
  timeoutMs: number,
): Promise<{ buf: Buffer; mime: string } | null> {
  if (refs.length) return openaiEdit(key, model, prompt, refs, size, quality, timeoutMs);
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      prompt: prompt.slice(0, 32_000),
      n: 1,
      size,
      quality,
      output_format: 'png',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    setImageErr(`OpenAI ${model} ${res.status}: ${(await res.text()).slice(0, 280)}`);
    return null;
  }
  const json = await res.json();
  const bytes = parseResultBytes(json);
  if (bytes) return bytes;
  const url = parseResult(json);
  if (!url || url.startsWith('data:')) return null;
  return bytesFromRef(url);
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
    for (const model of models) {
      try {
        const bytes = await openaiGenerateOnce(openaiKey, model, prompt, refs, size, quality, timeoutMs);
        if (bytes) return bytes;
      } catch (e) {
        setImageErr(`${model}: ${(e as Error).message}`);
      }
    }
    if (!lastImageErr) setImageErr('ChatGPT image generation returned empty');
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
