/**
 * Competitor discovery search terms.
 *
 * Search is deliberately WIDE (many multi-word phrases); relevance is decided
 * by the model reading each advertiser's ads (competitor-judge). The keyword
 * include/exclude here is only the fallback when the model cannot be asked.
 */

const ALWAYS_EXCLUDE = [
  'shopify', 'amazon', 'temu', 'shein', 'aliexpress', 'ebay',
  'hiring', 'we are hiring', 'dropshipping', 'print on demand', 'make money online',
];

export function fold(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

export function parseTermList(raw: string, sep = /[\n,|]+/): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw || '').split(sep)) {
    const k = part
      .replace(/^[\s\-*0-9.)\]]+/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    if (k.length < 3 || k.length > 80) continue;
    const key = fold(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** A search query that will not dump the whole ad library: two or more words. */
export function isSpecificKeyword(k: string): boolean {
  const t = k.trim();
  if (t.length < 8) return false;
  return t.split(/\s+/).filter(Boolean).length >= 2;
}

/** Bigrams from the product name after a brand prefix ("Wellaray — Slim Coffee"). */
export function seedPhrasesFromProduct(product: string): string[] {
  const parts = String(product || '')
    .split(/\s*[—–\-|/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tail = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '').trim();
  if (!tail) return [];
  const words = tail.split(/\s+/).filter((w) => w.length > 2);
  const out: string[] = [];
  if (words.length >= 2) out.push(words.join(' '));
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out.filter(isSpecificKeyword);
}

export function pickSearchTerms(candidates: string[], product: string, max = 8): string[] {
  const specific = candidates.filter(isSpecificKeyword);
  const seeds = seedPhrasesFromProduct(product);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const k of [...specific, ...seeds]) {
    const key = fold(k);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(k);
    if (merged.length >= max) break;
  }
  if (merged.length) return merged;
  const fallback = (product.split(/[—–\-|/]/).pop() || product).trim();
  return fallback ? [fallback] : [];
}

export interface DiscoveryLexicon {
  search: string[];
  include: string[];
  exclude: string[];
}

/**
 * Parse Claude's SEARCH / INCLUDE / EXCLUDE block. Also accepts a plain
 * one-keyword-per-line list (legacy).
 */
export function parseDiscoveryLexicon(raw: string, product: string): DiscoveryLexicon {
  const text = String(raw || '');
  const section = (name: string): string => {
    const re = new RegExp(`(?:^|\\n)\\s*${name}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:SEARCH|INCLUDE|EXCLUDE)\\s*:?\\s*\\n|$)`, 'i');
    const m = text.match(re);
    return m ? m[1] : '';
  };
  const hasSections = /(?:^|\n)\s*(SEARCH|INCLUDE|EXCLUDE)\s*:?\s*\n/i.test(text);
  const search = parseTermList(hasSections ? section('SEARCH') : text);
  const include = parseTermList(section('INCLUDE'));
  const exclude = parseTermList(section('EXCLUDE'));
  const picked = pickSearchTerms(search, product, 8);
  // Do NOT require our brand name in the ad copy — that collapses discovery
  // to a single advertiser. INCLUDE stays category/mechanism signals.
  const includeMerged = parseTermList([...picked, ...include].join('\n')).slice(0, 16);
  const excludeMerged = parseTermList([...ALWAYS_EXCLUDE, ...exclude].join('\n')).slice(0, 20);
  return { search: picked, include: includeMerged, exclude: excludeMerged };
}

export function haystackOf(parts: Array<string | undefined | null>): string {
  return fold(parts.filter(Boolean).join(' \n '));
}

export function matchesAny(hay: string, terms: string[]): boolean {
  if (!hay || !terms.length) return false;
  return terms.some((t) => {
    const f = fold(t);
    return f.length >= 3 && hay.includes(f);
  });
}

/** True when this creative/landing belongs in the product's competitor set. */
export function isOnNiche(
  parts: Array<string | undefined | null>,
  include: string[],
  exclude: string[],
): boolean {
  if (!include.length) return true;
  const hay = haystackOf(parts);
  if (!hay) return false;
  const hitInclude = matchesAny(hay, include);
  if (!hitInclude) return false;
  // Exclude only wins when the include hit is just a weak generic word
  // sitting next to an off-niche trap (e.g. "coffee" + "coffee shop").
  if (matchesAny(hay, exclude) && !matchesAny(hay, include.filter((t) => t.trim().split(/\s+/).length >= 2 || t.trim().length >= 10))) {
    return false;
  }
  return true;
}

export function encodeLexiconParam(terms: string[]): string {
  return terms.join('|').slice(0, 700);
}

export function decodeLexiconParam(raw: string | null): string[] {
  if (!raw) return [];
  return parseTermList(raw, /[|]+/);
}
