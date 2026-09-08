import { requireAnthropicKey } from '@/lib/anthropic-key';

/** Server-only. Do not import this file from client components — it uses sharp. */

/** The model looks at each current image, then reads nearby copy. */

export type PlaceSlotIn = {
  id: number;
  kind: string;
  context: string;
  src?: string;
  /** For video slots: the poster frame, which is what can be previewed. */
  poster?: string;
  width?: number;
  height?: number;
};

export type PlaceLibIn = {
  id: string;
  kind: string;
  name: string;
  file: string;
  /** Absolute URL the server can fetch to show the model a thumbnail. */
  previewUrl?: string;
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
  /** The page was built for ANOTHER product and is being turned into ours:
   *  every picture of the old product must go, library reuse is expected. */
  convert?: boolean;
  /** False when the caller cannot render generate=true (affiliate: real offer photos only). */
  canGenerate?: boolean;
}): Promise<PlaceAssignment[]> {
  const slots = args.slots.slice(0, 100);
  const library = args.library.slice(0, 60);
  if (!slots.length) return [];
  const canGenerate = args.canGenerate !== false;

  const [seen, libSeen] = await Promise.all([
    loadSlotImages(slots, args.pageUrl || ''),
    loadLibraryThumbs(library),
  ]);

  const head = `${args.description ? `Product: ${args.description.slice(0, 600)}\n` : ''}${args.brief ? `Brief: ${args.brief.slice(0, 800)}\n` : ''}
For each slot you are shown the picture that is already there, plus the text around it.`;
  const genRule = canGenerate
    ? (args.convert
      ? `When no library file shows the subject the copy asks for, generate=true with an English image prompt (at most 8 per page). GENERATE ONLY ILLUSTRATIONS — the problem moment, a person in the situation the copy describes, a comparison, a diagram, an ingredient, a lifestyle scene. NEVER generate the product itself (its stick, sachet, box, label, logo, hands holding it): product shots come from the library only. A photo that contradicts the copy (fruit under "look at this image of the 9pm pantry raid") is a failure — generate instead.`
      : 'When no library file fits, generate=true with an English image prompt (at most 8).')
    : 'Image generation is NOT available here: never answer generate=true. When nothing fits perfectly, pick the closest library file anyway.';

  const system = args.convert
    ? `This landing page was built for a DIFFERENT product. It is being converted to sell "${args.productName}", and the copy is being rewritten for it.
${head}

LOOK at the picture first.
- UI chrome (stars, rating bars, checkmarks, ticks, logos, arrows, payment marks, bullets, flags) → skip it.
- Any picture that shows the OLD product — the item itself, its box, its app screen, hands or feet using it, before/after of its results, its brand name — MUST be replaced. Leaving one on the page is the worst possible outcome. Read the REWRITTEN copy around the slot and decide what the picture should now show: a product shot where the copy presents/sells the product (library), an illustration of the situation where the copy tells a story or explains a mechanism. Pick a library file only when it really shows that subject; the library is small, so the same product file in several product slots is expected and fine. If unsure whether a photo shows the old product, replace it.
- A photo with NO product in it (a doctor portrait, a landscape, a smiling person, a generic ingredient) may stay only when it still fits the new copy; otherwise replace it too.
- VIDEO slots: you see the poster frame when there is one, otherwise only the copy. These clips show the old product in use: replace every one. Pick a library video if one fits, otherwise the best matching still photo (it is shown as a slowly animated still).
${genRule}

Return STRICT JSON only:
{"slots":[{"id":0,"skip":true,"mediaId":null,"generate":false,"prompt":""}]}
One object per input id.`
    : `You are looking at the CURRENT images on a landing page for "${args.productName}".
${head}

LOOK at the picture first.
- If it is UI chrome (stars, rating bars, checkmarks, ticks, logos, arrows, payment marks, bullets) → skip it. Do not replace it.
- If it is a real photograph or illustration → decide what SHOULD be there from the nearby copy (a doctor if the copy is about a doctor, an object if the copy is about an object, and so on). Then either pick a library id whose file clearly matches that subject, or generate=true with an English image prompt.
- VIDEO slots: you see the poster frame when there is one, otherwise only the copy. These are content clips, never chrome. Pick a library video if one fits; otherwise pick the best matching still photo (it will be shown as a slowly animated still) or generate=true. Do not skip a video slot unless the copy gives you nothing to go on.

The library is this offer's own photos: prefer them over generating. Never put a photo on stars or ticks. Never pick a library file just because it is unused; the same file may be reused only when the copy really asks for the same subject. ${genRule} If unsure about an image slot, skip.

Return STRICT JSON only:
{"slots":[{"id":0,"skip":true,"mediaId":null,"generate":false,"prompt":""}]}
One object per input id.`;

  const libraryContent: ContentPart[] = [
    { type: 'text', text: `LIBRARY — this offer's own files (${library.length}). Look at each one so you know what it shows:` },
  ];
  for (const m of library) {
    const thumb = libSeen.get(m.id);
    libraryContent.push({
      type: 'text',
      text: `LIBRARY id=${m.id} (${m.kind})${thumb ? '' : ` file: ${m.file.slice(0, 100) || m.name.slice(0, 80) || '(no preview)'}`}`,
    });
    if (thumb) {
      libraryContent.push({ type: 'image', source: { type: 'base64', media_type: thumb.mime, data: thumb.data } });
    }
  }

  // One request can carry ~100 images: the library plus a batch of slots.
  const perBatch = Math.max(8, Math.min(24, 90 - libSeen.size));
  const batches: PlaceSlotIn[][] = [];
  for (let i = 0; i < slots.length; i += perBatch) batches.push(slots.slice(i, i + perBatch));
  const libIds = new Set(library.map((m) => m.id));

  const results = await Promise.all(
    batches.map(async (batch) => {
      const content: ContentPart[] = [
        ...libraryContent,
        { type: 'text', text: `SLOTS follow (${batch.length}) — the images currently on the page. Look at each one.` },
      ];
      for (const s of batch) {
        content.push({
          type: 'text',
          text: `SLOT ${s.id} (${s.kind}${s.width && s.height ? `, ${s.width}x${s.height}` : ''})\nNearby copy: ${s.context.slice(0, 220) || '(none)'}`,
        });
        const img = seen.get(s.id);
        if (img) {
          content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
        } else if (s.kind === 'video') {
          content.push({ type: 'text', text: '(video clip, no poster to preview — choose from the copy)' });
        } else {
          content.push({
            type: 'text',
            text: args.convert
              ? '(no preview — judge from the copy: if it reads like a product/demo/result picture, replace it)'
              : '(no preview — skip unless you are sure this is a content photo)',
          });
        }
      }
      try {
        const raw = await callClaudeVision(system, content);
        return parseAssignments(raw, batch, libIds);
      } catch (e) {
        if (batches.length === 1) throw e;
        return batch.map((s) => ({ slotId: s.id, mediaId: null, generate: false, prompt: '' }));
      }
    }),
  );

  let generates = 0;
  return results.flat().map((a) => {
    if (!a.generate) return a;
    generates += 1;
    return canGenerate && generates <= 8 ? a : { ...a, generate: false, prompt: '' };
  });
}

async function loadSlotImages(
  slots: PlaceSlotIn[],
  pageUrl: string,
): Promise<Map<number, { mime: string; data: string }>> {
  const out = new Map<number, { mime: string; data: string }>();
  const jobs = slots.map(async (s) => {
    const previewSrc = s.kind === 'video' ? s.poster || '' : s.src || '';
    const url = absolutize(previewSrc, pageUrl);
    if (!url || !/^https?:\/\//i.test(url)) return;
    const got = await fetchPreview(url);
    if (got) out.set(s.id, got);
  });
  await Promise.all(jobs);
  return out;
}

async function loadLibraryThumbs(
  library: PlaceLibIn[],
): Promise<Map<string, { mime: string; data: string }>> {
  const out = new Map<string, { mime: string; data: string }>();
  const jobs = library.map(async (m) => {
    if (m.kind === 'video') return;
    const url = String(m.previewUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const got = await fetchPreview(url, 256);
    if (got) out.set(m.id, got);
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

export async function fetchPreview(url: string, size = 512): Promise<{ mime: string; data: string } | null> {
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
    return shrinkPreview(buf, rawMime || 'image/jpeg', size);
  } catch {
    return null;
  }
}

async function shrinkPreview(buf: Buffer, mime: string, size: number): Promise<{ mime: string; data: string } | null> {
  try {
    const sharp = (await import('sharp')).default;
    const data = await sharp(buf)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
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
