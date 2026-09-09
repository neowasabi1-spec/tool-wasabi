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

function parseResult(json: unknown): string | null {
  const row = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0];
  if (!row) return null;
  if (row.b64_json) return `data:image/png;base64,${row.b64_json}`;
  if (row.url) return row.url;
  return null;
}

async function blobFromRef(url: string): Promise<Blob | null> {
  try {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] || 'image/png' });
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
    return new Blob([buf], { type });
  } catch {
    return null;
  }
}

async function openaiEdit(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
  timeoutMs: number,
): Promise<string | null> {
  const jsonRes = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      prompt: prompt.slice(0, 32_000),
      images: refs.map((image_url) => ({ image_url })),
      n: 1,
      size,
      quality,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (jsonRes.ok) return parseResult(await jsonRes.json());
  const jsonErr = await jsonRes.text();
  console.warn('[openai-image] edit json', jsonRes.status, jsonErr.slice(0, 300));

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt.slice(0, 32_000));
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', quality);
  let attached = 0;
  for (let i = 0; i < refs.length; i++) {
    const blob = await blobFromRef(refs[i]);
    if (!blob) continue;
    form.append('image[]', blob, `ref-${i}.png`);
    attached++;
  }
  if (!attached) return null;
  const mp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!mp.ok) {
    console.warn('[openai-image] edit multipart', mp.status, (await mp.text()).slice(0, 300));
    return null;
  }
  return parseResult(await mp.json());
}

/** Text-to-image, or image-to-image when imageUrls is set. Returns a data URL (or http URL). */
export async function openaiGenerateImage(opts: {
  prompt: string;
  imageUrls?: string[];
  size?: string;
  quality?: string;
  timeoutMs?: number;
  onTick?: () => Promise<void>;
}): Promise<string | null> {
  const key = openaiImageKey();
  if (!key) {
    console.warn('[openai-image] OPENAI_API_KEY missing');
    return null;
  }
  const prompt = (opts.prompt || '').trim();
  if (!prompt) return null;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const size = mapSize(opts.size);
  const quality = mapQuality(opts.quality);
  const model = openaiImageModel();
  const tick = opts.onTick;
  const iv = tick ? setInterval(() => { void tick(); }, 8_000) : null;
  try {
    const refs = (opts.imageUrls || []).filter(Boolean).slice(0, 16);
    if (refs.length) {
      return await openaiEdit(key, model, prompt, refs, size, quality, timeoutMs);
    }
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
      console.warn('[openai-image] generate', res.status, (await res.text()).slice(0, 400));
      return null;
    }
    return parseResult(await res.json());
  } catch (e) {
    console.warn('[openai-image] threw:', (e as Error).message);
    return null;
  } finally {
    if (iv) clearInterval(iv);
  }
}
