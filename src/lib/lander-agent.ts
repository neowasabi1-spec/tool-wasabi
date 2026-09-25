/**
 * Clone-time understand agent.
 *
 * Known families (chat-quiz / hidden-stepper / faq) keep the local heal.
 * Unrecognized pages get a screenshot + Claude pass that:
 *   1. labels texts / images / videos for swipe
 *   2. picks an interactivity recipe (generic stepper if needed)
 */

import { getAnthropicKey } from './anthropic-key';
import { healClonedLander, injectGenericStepEngine, readHealStamp } from './lander-heal';
import {
  buildSwipeAssetMap,
  compactSwipeMap,
  type LanderFamily,
  type SwipeAssetMap,
  type SwipeTextRole,
} from './swipe-asset-map';

const FAMILIES: LanderFamily[] = [
  'chat-quiz',
  'hidden-stepper',
  'faq',
  'vsl',
  'checkout',
  'advertorial',
  'landing',
  'unknown',
];

const TEXT_ROLES: SwipeTextRole[] = [
  'headline',
  'subhead',
  'body',
  'bullet',
  'cta',
  'question',
  'label',
  'alt',
  'meta',
  'other',
];

export type LanderAgentResult = {
  html: string;
  map: SwipeAssetMap;
  visioned: boolean;
};

function needsVision(map: SwipeAssetMap, remaining: { id: string }[]): boolean {
  if (remaining.length > 0) return true;
  if (map.family === 'unknown') return true;
  if (map.texts.length < 3) return true;
  return false;
}

async function fetchPageSnapshot(url: string): Promise<{ mediaType: string; data: string } | null> {
  if (!/^https?:\/\//i.test(url) || /uploaded\.local/i.test(url)) return null;
  const shot = `https://image.thum.io/get/width/1024/noanimate/${encodeURIComponent(url)}`;
  try {
    const res = await fetch(shot, {
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2_000 || buf.length > 1_400_000) return null;
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const mediaType = ct.startsWith('image/') ? ct : 'image/jpeg';
    return { mediaType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

type AgentJson = {
  family?: string;
  interactivity?: string;
  texts?: Array<{ id: number; role?: string }>;
  media?: Array<{ id: number; role?: string }>;
};

function parseAgentJson(raw: string): AgentJson | null {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  try {
    return JSON.parse(c) as AgentJson;
  } catch {
    return null;
  }
}

function applyLabels(map: SwipeAssetMap, parsed: AgentJson): SwipeAssetMap {
  const family = FAMILIES.includes(parsed.family as LanderFamily)
    ? (parsed.family as LanderFamily)
    : map.family;
  const textRoles = new Map((parsed.texts || []).map((t) => [t.id, t.role]));
  const mediaRoles = new Map((parsed.media || []).map((m) => [m.id, m.role]));
  return {
    ...map,
    family,
    understood: true,
    source: 'agent',
    texts: map.texts.map((t) => {
      const role = textRoles.get(t.id);
      return role && TEXT_ROLES.includes(role as SwipeTextRole)
        ? { ...t, role: role as SwipeTextRole }
        : t;
    }),
    images: map.images.map((m) => {
      const role = mediaRoles.get(m.id);
      return role ? { ...m, role: String(role).slice(0, 40) } : m;
    }),
    videos: map.videos.map((m) => {
      const role = mediaRoles.get(m.id);
      return role ? { ...m, role: String(role).slice(0, 40) } : m;
    }),
  };
}

async function labelWithClaude(args: {
  url: string;
  map: SwipeAssetMap;
  snapshot: { mediaType: string; data: string } | null;
}): Promise<AgentJson | null> {
  const key = getAnthropicKey();
  if (!key) return null;

  const outline = {
    url: args.url,
    familyGuess: args.map.family,
    steps: args.map.steps,
    healed: args.map.healed,
    texts: args.map.texts.slice(0, 80).map((t) => ({ id: t.id, tag: t.tag, role: t.role, text: t.text.slice(0, 180) })),
    images: args.map.images.slice(0, 24).map((m) => ({ id: m.id, kind: m.kind, role: m.role, alt: m.alt, src: m.src.slice(0, 160) })),
    videos: args.map.videos.slice(0, 12).map((m) => ({ id: m.id, kind: m.kind, role: m.role, src: m.src.slice(0, 160) })),
    ctas: args.map.ctas.slice(0, 16),
  };

  const system = `You map a competitor landing so a swipe engine can rewrite copy and restyle media.
Return STRICT JSON only:
{
  "family":"chat-quiz|hidden-stepper|faq|vsl|checkout|advertorial|landing|unknown",
  "interactivity":"none|generic-step|chat-quiz",
  "texts":[{"id":0,"role":"headline|subhead|body|bullet|cta|question|label|alt|meta|other"}],
  "media":[{"id":0,"role":"hero|product|lifestyle|testimonial|video|logo|other"}]
}
Rules:
- One object per input id you are sure about. Skip junk (legal crumbs, pixels, country pickers).
- interactivity=generic-step when the page hides steps / quiz panels and needs click-to-reveal.
- interactivity=chat-quiz only for messenger/chat UIs.
- Image/video ids refer to the media arrays (images then videos keep their own ids).`;

  const userText = `Map this landing.\n${JSON.stringify(outline)}`;
  const content: Array<Record<string, unknown>> = [];
  if (args.snapshot) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: args.snapshot.mediaType,
        data: args.snapshot.data,
      },
    });
    content.push({ type: 'text', text: 'Screenshot of the live page (may be the first screen only).\n' + userText });
  } else {
    content.push({ type: 'text', text: userText });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(22_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  return parseAgentJson(text);
}

function stampMapMeta(html: string, map: SwipeAssetMap): string {
  const content = `family=${map.family};texts=${map.texts.length};images=${map.images.length};videos=${map.videos.length};source=${map.source}`;
  const tag = `<meta name="wasabi-swipe-map" content="${content.replace(/"/g, '')}">`;
  let out = html.replace(/<meta\s+name=["']wasabi-swipe-map["'][^>]*>/gi, '');
  if (/<\/head>/i.test(out)) return out.replace(/<\/head>/i, `${tag}</head>`);
  return tag + out;
}

export async function understandLander(html: string, url = ''): Promise<LanderAgentResult> {
  const healed = healClonedLander(html);
  let outHtml = healed.html;
  let map = buildSwipeAssetMap(outHtml);
  const remaining = readHealStamp(outHtml).remaining;
  // Screenshot only when the tool is unsure. Labeling runs on every page.
  const vision = needsVision(map, remaining);

  let parsed: AgentJson | null = null;
  let snapshot: { mediaType: string; data: string } | null = null;
  if (vision && url) snapshot = await fetchPageSnapshot(url);
  try {
    parsed = await labelWithClaude({ url, map, snapshot });
  } catch {
    parsed = null;
  }

  if (parsed) {
    map = applyLabels(map, parsed);
    const recipe = String(parsed.interactivity || '');
    if (recipe === 'generic-step' && !/wasabi-generic-step-engine/.test(outHtml) && !/wasabi-chat-quiz-engine/.test(outHtml)) {
      outHtml = injectGenericStepEngine(outHtml);
      if (!map.healed.includes('generic-step')) map.healed = [...map.healed, 'generic-step'];
    }
  }

  map = compactSwipeMap({ ...map, understood: map.understood || !!parsed });
  outHtml = stampMapMeta(outHtml, map);
  return { html: outHtml, map, visioned: !!snapshot };
}
