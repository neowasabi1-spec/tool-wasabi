// Filtra le voci grezze dell'estrattore v2 (universal-text-extractor) per
// renderle adatte a un round di rewrite AI marketing-safe.
//
// L'estrattore v2 cattura 10 famiglie di stringhe: title, meta, tag, mixed,
// attr, url, email, json-ld, script:string, phone. Per uno swipe vogliamo
// SOLO il copy visibile (title / meta:description / tag / mixed / attr safe).
// URL, email, phone, script string, attributi data-* etc. vanno scartati:
// riscriverli rompe routing, tracking, og:image, widget JS embed, ecc.

import type { ExtractedText as UniversalText } from './universal-text-extractor';

export interface SwipeText {
  original: string;
  tag: string; // 'title' | 'attr:meta-content' | 'attr:NAME' | 'p' | 'h1' | ... | 'div'
  position: number;
}

export const DEFAULT_MAX_TEXTS = 350;

const SAFE_CONTEXT_EXACT = new Set(['title', 'meta:content']);

const SAFE_CONTEXT_PREFIXES = [
  'tag:h1', 'tag:h2', 'tag:h3', 'tag:h4', 'tag:h5', 'tag:h6',
  'tag:p', 'tag:li', 'tag:td', 'tag:th', 'tag:dt', 'tag:dd',
  'tag:button', 'tag:a', 'tag:label', 'tag:figcaption',
  'tag:blockquote', 'tag:summary', 'tag:legend', 'tag:option',
  'tag:span', 'tag:strong', 'tag:em', 'tag:b', 'tag:i', 'tag:u',
  'tag:small', 'tag:mark', 'tag:cite', 'tag:q', 'tag:abbr',
  'mixed:p', 'mixed:div', 'mixed:li', 'mixed:td', 'mixed:th',
  'mixed:h1', 'mixed:h2', 'mixed:h3', 'mixed:h4', 'mixed:h5', 'mixed:h6',
  'mixed:span', 'mixed:strong', 'mixed:em', 'mixed:a', 'mixed:b', 'mixed:i',
  'attr:alt', 'attr:title', 'attr:placeholder', 'attr:aria-label', 'attr:value',
];

function isSafeContext(ctx: string): boolean {
  if (SAFE_CONTEXT_EXACT.has(ctx)) return true;
  return SAFE_CONTEXT_PREFIXES.some((p) => ctx === p || ctx.startsWith(p + ':'));
}

const TAG_PRIORITY: Record<string, number> = {
  title: 0,
  h1: 1, h2: 1, h3: 2, h4: 3, h5: 4, h6: 4,
  p: 2, li: 2, button: 1, a: 3, label: 3,
  td: 4, th: 4, dt: 4, dd: 4, blockquote: 4, summary: 4, legend: 4, figcaption: 4,
  option: 5, span: 6, strong: 6, em: 6, b: 6, i: 6, u: 6,
  small: 6, mark: 6, cite: 6, q: 6, abbr: 6,
  div: 7,
  'attr:alt': 5, 'attr:title': 5, 'attr:placeholder': 5,
  'attr:aria-label': 5, 'attr:value': 5,
  'attr:meta-content': 5,
};
function priorityOf(tag: string): number {
  if (TAG_PRIORITY[tag] !== undefined) return TAG_PRIORITY[tag];
  if (tag.startsWith('attr:')) return 5;
  return 8;
}

export interface FilterOptions {
  maxTexts?: number;
}

export function filterAndCap(
  universal: UniversalText[],
  options: FilterOptions = {},
): SwipeText[] {
  const maxTexts = Math.max(50, Math.min(800, options.maxTexts ?? DEFAULT_MAX_TEXTS));
  const collected: SwipeText[] = [];
  const seen = new Map<string, SwipeText>();

  for (const u of universal) {
    if (!isSafeContext(u.context)) continue;
    if (u.text.length < 2 || u.text.length > 800) continue;
    if (!/[a-zA-Z]/.test(u.text)) continue;
    if (u.text.startsWith('http://') || u.text.startsWith('https://')) continue;
    if (u.text.includes('{') && u.text.includes('}') && /[=:]\s*function|=>/.test(u.text)) continue;

    let mappedTag = u.context;
    if (u.context.startsWith('attr:')) mappedTag = u.context;
    else if (u.context.startsWith('tag:')) mappedTag = u.context.slice(4);
    else if (u.context.startsWith('mixed:')) mappedTag = u.context.slice(6);
    else if (u.context === 'title') mappedTag = 'title';
    else if (u.context === 'meta:content') mappedTag = 'attr:meta-content';

    const existing = seen.get(u.text);
    const newPrio = priorityOf(mappedTag);
    if (existing) {
      if (newPrio < priorityOf(existing.tag)) {
        existing.tag = mappedTag;
        existing.position = u.position;
      }
      continue;
    }
    const entry: SwipeText = { original: u.text, tag: mappedTag, position: u.position };
    seen.set(u.text, entry);
    collected.push(entry);
  }

  if (collected.length > maxTexts) {
    collected.sort((a, b) => priorityOf(a.tag) - priorityOf(b.tag));
    return collected.slice(0, maxTexts);
  }
  return collected;
}
