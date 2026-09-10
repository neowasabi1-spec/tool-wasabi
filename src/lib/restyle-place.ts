import { requireAnthropicKey } from './anthropic-key';

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
  /** The page-level swipe plan (narrator, root cause, mechanism, promised outcome): what the rewritten copy is about. */
  story?: string;
  /** Cap on generate=true assignments for the page (default 8). */
  maxGenerate?: number;
}): Promise<PlaceAssignment[]> {
  const slots = args.slots.slice(0, 100);
  const library = args.library.slice(0, 60);
  if (!slots.length) return [];
  const canGenerate = args.canGenerate !== false;
  const maxGenerate = Math.max(0, args.maxGenerate ?? 8);

  const [seen, libSeen] = await Promise.all([
    loadSlotImages(slots, args.pageUrl || ''),
    loadLibraryThumbs(library),
  ]);

  const head = `${args.description ? `PRODUCT (what it is, who it is for, what it does):\n${args.description.slice(0, 1500)}\n` : ''}${args.brief ? `BRIEF:\n${args.brief.slice(0, 1200)}\n` : ''}${args.story ? `THE STORY THE REWRITTEN PAGE TELLS (every picture must serve this):\n${args.story.slice(0, 2500)}\n` : ''}
For each slot you are shown the picture that is already there, plus the text around it.`;
  const promptGuide = `HOW TO WRITE AN IMAGE PROMPT (the "prompt" field, English, 40-90 words): describe ONE concrete scene that shows what the copy MEANS for the reader — the problem they live with, the moment the copy describes, or the result they want (the person, what they are doing and feeling, the setting, light, camera). Illustrate the OUTCOME or the SITUATION, never the act of consuming anything: no one swallowing, taking or holding pills, capsules, tablets, medication, syringes or supplements, no pharmacy or clinic imagery, unless the copy is literally about that. Example — copy about losing weight: a woman noticing her jeans are loose, a light satisfied dinner, a smiling step onto a scale; NOT a woman taking a pill. No product, no packaging, no text, no logos in the scene.`;
  const genRule = canGenerate
    ? (args.convert
      ? `WHEN TO GENERATE: for every slot whose copy tells a story, describes a moment, explains a mechanism, shows a person, a comparison, an ingredient or a lifestyle scene, answer generate=true with an image prompt — UNLESS a library file genuinely shows that exact subject. Up to ${maxGenerate} per page: spend them on the slots the reader looks at most (hero, problem, mechanism, results, testimonials), in page order. Library files are the offer's OWN photos (the product, its packaging, real customers if any): use them for slots whose copy presents or sells the product; do NOT drop the same product photo into story slots just to fill them — a product photo under "this is what 9pm hunger feels like" is a failure, generate instead. NEVER generate the product itself (its stick, sachet, box, label, logo, hands holding it).
${promptGuide}`
      : `When no library file fits, generate=true with an English image prompt (up to ${maxGenerate}).\n${promptGuide}`)
    : 'Image generation is NOT available here: never answer generate=true. When nothing fits perfectly, pick the closest library file anyway.';

  const system = args.convert
    ? `This landing page was built for a DIFFERENT product. It is being converted to sell "${args.productName}", and the copy has been rewritten for it.
${head}

LOOK at the picture first.
- UI chrome (stars, rating bars, checkmarks, ticks, logos, arrows, payment marks, bullets, flags) → skip it.
- Any picture that shows the OLD product — the item itself, its box, its app screen, hands or feet using it, before/after of its results, its brand name — MUST be replaced. Leaving one on the page is the worst possible outcome. Read the REWRITTEN copy around the slot and decide what the picture should now show: a product shot (library) where the copy presents/sells the product; an illustration of the situation (generate) where the copy tells a story, describes a problem, a result or a mechanism. Pick a library file only when it really shows that subject. If unsure whether a photo shows the old product, replace it.
- A photo with NO product in it (a doctor portrait, a landscape, a smiling person, a generic ingredient) may stay only when it still fits the new copy; otherwise replace it too.
- VIDEO slots: you see the poster frame when there is one, otherwise only the copy. These clips show the old product in use: replace every one. Pick a library video if one fits, otherwise generate an illustration or pick the best matching still photo (it is shown as a slowly animated still).
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
          text: `SLOT ${s.id} (${s.kind}${s.width && s.height ? `, ${s.width}x${s.height}` : ''})\nNearby copy: ${s.context.slice(0, 500) || '(none)'}`,
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
    return canGenerate && generates <= maxGenerate ? a : { ...a, generate: false, prompt: '' };
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

/** Dominant packshot colours when vision/palette JSON is missing. Never gray. */
export async function samplePackshotPalette(url: string): Promise<{
  primary: string; secondary: string; accent: string; background: string;
} | null> {
  try {
    let buf: Buffer;
    if (/^data:image\//i.test(url)) {
      const m = url.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
      if (!m) return null;
      buf = Buffer.from(m[1], 'base64');
    } else {
      const res = await fetch(url, {
        headers: {
          accept: 'image/*,*/*',
          'user-agent': 'Mozilla/5.0 (compatible; WasabiPreview/1.0)',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (buf.length < 40 || buf.length > 8_000_000) return null;
    const sharp = (await import('sharp')).default;
    const { dominant } = await sharp(buf).resize(80, 80, { fit: 'inside' }).stats();
    const { r, g, b } = dominant;
    if (Math.max(r, g, b) - Math.min(r, g, b) < 16) return null;
    const hex = (rr: number, gg: number, bb: number) =>
      `#${[rr, gg, bb].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
    return {
      primary: hex(r, g, b),
      secondary: hex(r * 0.42, g * 0.38, b * 0.40),
      accent: hex(Math.min(255, r * 1.12), Math.min(255, g * 0.92), Math.min(255, b * 0.62)),
      background: hex(r * 0.10 + 255 * 0.90, g * 0.10 + 255 * 0.90, b * 0.10 + 255 * 0.90),
    };
  } catch {
    return null;
  }
}

export async function fetchPreview(url: string, size = 512): Promise<{ mime: string; data: string } | null> {
  try {
    let buf: Buffer;
    let rawMime = 'image/jpeg';
    if (/^data:image\//i.test(url)) {
      const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!m) return null;
      rawMime = m[1];
      buf = Buffer.from(m[2], 'base64');
    } else {
      const res = await fetch(url, {
        headers: {
          accept: 'image/*,*/*',
          'user-agent': 'Mozilla/5.0 (compatible; WasabiPreview/1.0)',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      rawMime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (rawMime && !rawMime.startsWith('image/')) return null;
      buf = Buffer.from(await res.arrayBuffer());
    }
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
  // The page-level cap is applied by the caller after all batches are merged
  // (a per-batch cap silently dropped illustrations in the later batches).
  return slots.map((s) => {
    const row = byId.get(s.id);
    if (row?.skip) return { slotId: s.id, mediaId: null, generate: false, prompt: '' };
    const mediaId = row?.mediaId != null && row.mediaId !== '' && row.mediaId !== 'null'
      ? String(row.mediaId)
      : null;
    const known = mediaId && libIds.has(mediaId) ? mediaId : null;
    const generate = !known && !!row?.generate && !!(row.prompt || '').trim();
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
