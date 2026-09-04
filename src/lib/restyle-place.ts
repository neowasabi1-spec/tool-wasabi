import { requireAnthropicKey } from '@/lib/anthropic-key';

/** Server-only. Do not import this file from client components — it uses sharp. */

/** The model looks at each current image, then reads nearby copy. */

export type PlaceSlotIn = {
  id: number;
  kind: string;
  context: string;
  src?: string;
  width?: number;
  height?: number;
};

export type PlaceLibIn = {
  id: string;
  kind: string;
  name: string;
  file: string;
};

export type PlaceAssignment = {
  slotId: number;
  mediaId: string | null;
  generate: boolean;
  prompt: string;
};

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export async function placeMediaWithAi(args: {
  productName: string;
  brief?: string;
  description?: string;
  pageUrl?: string;
  slots: PlaceSlotIn[];
  library: PlaceLibIn[];
}): Promise<PlaceAssignment[]> {
  const slots = args.slots.slice(0, 24);
  const library = args.library.slice(0, 60);
  if (!slots.length) return [];

  const seen = await loadSlotImages(slots, args.pageUrl || '');

  const system = `You are looking at the CURRENT images on a landing page for "${args.productName}".
${args.description ? `Product: ${args.description.slice(0, 600)}\n` : ''}${args.brief ? `Brief: ${args.brief.slice(0, 800)}\n` : ''}
For each slot you are shown the picture that is already there, plus the text around it.

LOOK at the picture first.
- If it is UI chrome (stars, rating bars, checkmarks, ticks, logos, arrows, payment marks, bullets) → skip it. Do not replace it.
- If it is a real photograph or illustration → decide what SHOULD be there from the nearby copy (a doctor if the copy is about a doctor, an object if the copy is about an object, and so on). Then either pick a library id whose file clearly matches that subject, or generate=true with an English image prompt.

Never put a photo on stars or ticks. Never pick a library file just because it is unused. At most 8 generate=true. If unsure, skip.

Return STRICT JSON only:
{"slots":[{"id":0,"skip":true,"mediaId":null,"generate":false,"prompt":""}]}
One object per input id.`;

  const content: ContentPart[] = [
    {
      type: 'text',
      text: `Library files:\n${JSON.stringify(library.map((m) => ({
        id: m.id,
        kind: m.kind,
        name: m.name.slice(0, 80),
        file: m.file.slice(0, 120),
      })))}\n\nSlots follow. Look at each image.`,
    },
  ];

  for (const s of slots) {
    content.push({
      type: 'text',
      text: `SLOT ${s.id} (${s.kind}${s.width && s.height ? `, ${s.width}x${s.height}` : ''})\nNearby copy: ${s.context.slice(0, 220) || '(none)'}`,
    });
    const img = seen.get(s.id);
    if (img) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.data },
      });
    } else {
      content.push({ type: 'text', text: '(no preview — skip unless you are sure this is a content photo)' });
    }
  }

  const raw = await callClaudeVision(system, content);
  return parseAssignments(raw, slots, new Set(library.map((m) => m.id)));
}

async function loadSlotImages(
  slots: PlaceSlotIn[],
  pageUrl: string,
): Promise<Map<number, { mime: string; data: string }>> {
  const out = new Map<number, { mime: string; data: string }>();
  const jobs = slots.map(async (s) => {
    const url = absolutize(s.src || '', pageUrl);
    if (!url || !/^https?:\/\//i.test(url)) return;
    const got = await fetchPreview(url);
    if (got) out.set(s.id, got);
  });
  await Promise.all(jobs);
  return out;
}

function absolutize(src: string, pageUrl: string): string {
  const t = String(src || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  if (!pageUrl) return '';
  try {
    return new URL(t, pageUrl).href;
  } catch {
    return '';
  }
}

async function fetchPreview(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'image/*,*/*',
        'user-agent': 'Mozilla/5.0 (compatible; WasabiPreview/1.0)',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const rawMime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (rawMime && !rawMime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 40 || buf.length > 6_000_000) return null;
    return shrinkPreview(buf, rawMime || 'image/jpeg');
  } catch {
    return null;
  }
}

async function shrinkPreview(buf: Buffer, mime: string): Promise<{ mime: string; data: string } | null> {
  try {
    const sharp = (await import('sharp')).default;
    const data = await sharp(buf)
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 62 })
      .toBuffer();
    return { mime: 'image/jpeg', data: data.toString('base64') };
  } catch {
    if (buf.length > 350_000) return null;
    const ok = /^image\/(jpeg|png|gif|webp)$/.test(mime) ? mime : 'image/jpeg';
    return { mime: ok, data: buf.toString('base64') };
  }
}

function parseAssignments(
  raw: string,
  slots: PlaceSlotIn[],
  libIds: Set<string>,
): PlaceAssignment[] {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  let parsed: {
    slots?: Array<{ id?: number; skip?: boolean; mediaId?: string | null; generate?: boolean; prompt?: string }>;
  };
  try {
    parsed = JSON.parse(c);
  } catch {
    return slots.map((s) => ({ slotId: s.id, mediaId: null, generate: false, prompt: '' }));
  }
  const byId = new Map((parsed.slots || []).map((row) => [Number(row.id), row]));
  let generates = 0;
  return slots.map((s) => {
    const row = byId.get(s.id);
    if (row?.skip) return { slotId: s.id, mediaId: null, generate: false, prompt: '' };
    const mediaId = row?.mediaId != null && row.mediaId !== '' && row.mediaId !== 'null'
      ? String(row.mediaId)
      : null;
    const known = mediaId && libIds.has(mediaId) ? mediaId : null;
    let generate = !known && !!row?.generate && !!(row.prompt || '').trim();
    if (generate) {
      generates += 1;
      if (generates > 8) generate = false;
    }
    return {
      slotId: s.id,
      mediaId: known,
      generate,
      prompt: generate ? String(row?.prompt || '').slice(0, 800) : '',
    };
  });
}

async function callClaudeVision(system: string, content: ContentPart[]): Promise<string> {
  const key = requireAnthropicKey();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) throw new Error(`Place HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  if (!text.trim()) throw new Error('Place returned empty');
  return text;
}
