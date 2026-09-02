/**
 * Keep Chimera competitor discovery on-niche.
 *
 * Meta/TikTok/Google keyword search is loose: a term like "caffè" or
 * "weight loss" returns coffee shops, machines, gyms, SaaS. We only search
 * multi-word product phrases, and at ingest we drop creatives whose copy /
 * landing does not mention the product (or mentions a known off-niche trap).
 */

const WEAK_SINGLE =
  /^(coffee|caff[eè]|dieta?|health|salute|wellness|beauty|bellezza|vitamin[ae]?|supplement|integratore|dimagri\w*|weight|loss|slim|booster|offer|sale|promo|natural|organic|online|shop|product|best|top)$/i;

const ALWAYS_EXCLUDE = [
  'shopify', 'amazon', 'temu', 'shein', 'aliexpress', 'ebay',
  'coffee shop', 'coffee machine', 'espresso machine', 'macchina caffè',
  'macchina del caffè', 'barista', 'cafeteria', 'kaffeemaschine',
  'restaurant', 'hiring', 'we are hiring', 'karriere', 'recrut',
  'dropshipping', 'print on demand', 'make money online',
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

/** A search query that will not dump the whole ad library. */
export function isSpecificKeyword(k: string): boolean {
  const t = k.trim();
  if (t.length < 8) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.length === 1 && WEAK_SINGLE.test(words[0])) return false;
  return true;
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

export function pickSearchTerms(candidates: string[], product: string, max = 2): string[] {
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
  const picked = pickSearchTerms(search, product, 2);
  const includeMerged = parseTermList(
    [...picked, ...include, ...seedPhrasesFromProduct(product)].join('\n'),
  ).slice(0, 16);
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
