import { requireAnthropicKey } from '@/lib/anthropic-key';

/** AI reads nearby copy and decides what each slot should show. No product keyword lists. */

export type PlaceSlotIn = {
  id: number;
  kind: string;
  context: string;
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

export async function placeMediaWithAi(args: {
  productName: string;
  brief?: string;
  description?: string;
  slots: PlaceSlotIn[];
  library: PlaceLibIn[];
}): Promise<PlaceAssignment[]> {
  const slots = args.slots.slice(0, 40);
  const library = args.library.slice(0, 60);
  if (!slots.length) return [];

  const system = `You place images on a marketing landing page for "${args.productName}".
${args.description ? `Product: ${args.description.slice(0, 800)}\n` : ''}${args.brief ? `Brief: ${args.brief.slice(0, 1200)}\n` : ''}
For EVERY slot, read the nearby copy and decide what the picture must depict. The copy is the source of truth — not the current image, not leftover template art.

Then pick ONE:
- mediaId = a library id ONLY if that file's name/url clearly matches the same subject as the copy.
- generate = true + a full English image prompt if nothing in the library is that subject.

Rules:
- Understand the sentence next to the slot. Show that idea: a role, an object, a place, a process, a feeling — whatever the copy is actually about.
- Do not drop a leftover photo just because it is unused. A mismatch is worse than generating.
- Filenames are often random hashes. If you cannot tell what a library file is, do not pick it.
- Small images (under ~200px) next to a name/title are usually that person. Large images illustrate the paragraph topic, not a caption from another block.
- Reuse the same library id on several slots only when the subject is truly the same.
- At most 8 slots with generate=true (the worst mismatches). Other mismatches: generate false, mediaId null (leave the current image).
- Prompts: describe the scene, no HTML, no competitor brand names, no text painted in the image.

Return STRICT JSON only:
{"slots":[{"id":0,"mediaId":"12-or-null","generate":false,"prompt":""}]}
One object per input id. mediaId is a library id string or null.`;

  const user = JSON.stringify({
    slots: slots.map((s) => ({
      id: s.id,
      kind: s.kind,
      copy: s.context.slice(0, 280),
      size: s.width && s.height ? `${s.width}x${s.height}` : 'unknown',
    })),
    library: library.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name.slice(0, 80),
      file: m.file.slice(0, 120),
    })),
  });

  const raw = await callClaude(system, user);
  return parseAssignments(raw, slots, new Set(library.map((m) => m.id)));
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
  let parsed: { slots?: Array<{ id?: number; mediaId?: string | null; generate?: boolean; prompt?: string }> };
  try {
    parsed = JSON.parse(c);
  } catch {
    return slots.map((s) => ({ slotId: s.id, mediaId: null, generate: false, prompt: '' }));
  }
  const byId = new Map((parsed.slots || []).map((row) => [Number(row.id), row]));
  let generates = 0;
  return slots.map((s) => {
    const row = byId.get(s.id);
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

async function callClaude(system: string, user: string): Promise<string> {
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
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Place HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  if (!text.trim()) throw new Error('Place returned empty');
  return text;
}

export function libraryFileLabel(item: { name?: string; sourceUrl?: string; storedUrl?: string }): string {
  const fromName = String(item.name || '').split('|').pop() || '';
  const fromUrl = String(item.sourceUrl || item.storedUrl || '').split('/').pop()?.split('?')[0] || '';
  return (fromName || fromUrl || '').slice(0, 160);
}
