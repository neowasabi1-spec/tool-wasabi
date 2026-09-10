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

function parseResult(json: unknown): string | null {
  const row = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0];
  if (!row) return null;
  if (row.b64_json) return `data:image/png;base64,${row.b64_json}`;
  if (row.url) return row.url;
  return null;
}

function geminiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

function geminiBase(): string {
  return (process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
}

function geminiImageModel(): string {
  const raw = (process.env.PIPELINE_GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image').trim();
  return raw || 'gemini-2.5-flash-image';
}

function parseGeminiImage(json: unknown): string | null {
  const parts =
    (json as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
      ?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = (p.inlineData || p.inline_data) as
      | { data?: string; mimeType?: string; mime_type?: string }
      | undefined;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      return `data:${mime};base64,${inline.data}`;
    }
  }
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
  setImageErr(`OpenAI edit json ${jsonRes.status}: ${jsonErr.slice(0, 280)}`);

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
    setImageErr(`OpenAI edit multipart ${mp.status}`);
    return null;
  }
  return parseResult(await mp.json());
}

async function openaiGenerateOnce(
  key: string,
  model: string,
  prompt: string,
  refs: string[],
  size: string,
  quality: string,
  timeoutMs: number,
): Promise<string | null> {
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
  return parseResult(await res.json());
}

async function geminiGenerateImage(
  prompt: string,
  refs: string[],
  timeoutMs: number,
): Promise<string | null> {
  const key = geminiKey();
  if (!key) {
    if (!lastImageErr) setImageErr('GEMINI_API_KEY missing');
    return null;
  }
  const parts: Array<Record<string, unknown>> = [{ text: prompt.slice(0, 8_000) }];
  for (const url of refs.slice(0, 3)) {
    const blob = await blobFromRef(url);
    if (!blob) continue;
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length < 100) continue;
    parts.push({
      inlineData: {
        mimeType: (blob.type || 'image/png').split(';')[0],
        data: buf.toString('base64'),
      },
    });
  }
  const model = geminiImageModel();
  const res = await fetch(`${geminiBase()}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'x-goog-api-key': key,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    setImageErr(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 280)}`);
    return null;
  }
  return parseGeminiImage(await res.json());
}

/** Text-to-image, or image-to-image when imageUrls is set. Returns a data URL (or http URL).
 *  Tries OpenAI Images, then Gemini (Netlify AI Gateway) so packshots still
 *  generate when gpt-image is unavailable. */
export async function openaiGenerateImage(opts: {
  prompt: string;
  imageUrls?: string[];
  size?: string;
  quality?: string;
  timeoutMs?: number;
  onTick?: () => Promise<void>;
}): Promise<string | null> {
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
    const models = Array.from(new Set([openaiImageModel(), 'gpt-image-1'].filter(Boolean)));
    if (openaiKey) {
      for (const model of models) {
        try {
          const url = await openaiGenerateOnce(openaiKey, model, prompt, refs, size, quality, timeoutMs);
          if (url) return url;
        } catch (e) {
          setImageErr(`${model}: ${(e as Error).message}`);
        }
      }
    } else {
      setImageErr('OPENAI_API_KEY missing');
    }
    const gemini = await geminiGenerateImage(prompt, refs, timeoutMs);
    if (gemini) return gemini;
    if (!lastImageErr) setImageErr('image generation returned empty (OpenAI + Gemini)');
    return null;
  } catch (e) {
    setImageErr((e as Error).message);
    return null;
  } finally {
    if (iv) clearInterval(iv);
  }
}
