/**
 * Fast path for visual AI edit: "change SlimSoda with Sativora" must
 * finish instantly on a 5 000px <main>. Rewriting that HTML through
 * Claude is what times out on Netlify.
 */

export const LARGE_AI_HTML_CHARS = 8_000;

const STYLE_OR_LAYOUT =
  /\b(background|gradient|color|colour|font-size|padding|margin|layout|button|buttons|image|images|foto|immagine|colore|sfondo|size|width|height)\b/i;

const SWAP_RE =
  /^(?:please\s+)?(?:chang(?:e|es|ing|ei)?|cange|cambia(?:re)?|replace|sostituisci|rinomina(?:re)?|rename|swap|scambia)\s+["“”']?(.+?)["“”']?\s+(?:con|with|to|in|into|by|→|->|=>)\s+["“”']?(.+?)["“”']?[.!?]?$/i;

/** "cambia tutte le parole SlimSoda con X" → needle is SlimSoda, not the filler. */
function cleanSwapNeedle(from: string): string {
  return String(from || '')
    .trim()
    .replace(/^(?:tutte?\s+(?:le\s+)?)?(?:parole|occorrenze|volte|istanze)(?:\s+di)?\s+/i, '')
    .replace(/^tutte?\s+(?:le\s+)?/i, '')
    .replace(/^all(?:\s+the)?\s+(?:words?|occurrences?|instances?)(?:\s+of)?\s+/i, '')
    .replace(/^every(?:\s+(?:word|occurrence|instance))?(?:\s+of)?\s+/i, '')
    .replace(/^(?:the\s+)?(?:word|brand|name|product)\s+/i, '')
    .trim();
}

export function parseTextSwapInstruction(
  instruction: string,
): { from: string; to: string } | null {
  const s = String(instruction || '').trim().replace(/\s+/g, ' ');
  if (!s || STYLE_OR_LAYOUT.test(s)) return null;
  const m = s.match(SWAP_RE);
  if (!m) return null;
  const from = cleanSwapNeedle(m[1]);
  const to = m[2].trim();
  if (from.length < 2 || !to || from.toLowerCase() === to.toLowerCase()) return null;
  if (STYLE_OR_LAYOUT.test(from)) return null;
  return { from, to };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preserveCase(match: string, to: string): string {
  if (match === match.toUpperCase() && match !== match.toLowerCase()) return to.toUpperCase();
  if (match === match.toLowerCase()) return to.toLowerCase();
  if (match[0] === match[0].toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) {
    return to.charAt(0).toUpperCase() + to.slice(1);
  }
  return to;
}

function swapInText(text: string, re: RegExp, to: string): { text: string; count: number } {
  let count = 0;
  const next = text.replace(re, (match) => {
    count += 1;
    return preserveCase(match, to);
  });
  return { text: next, count };
}

/**
 * Replace `from` with `to` in visible copy only: text nodes + alt/title/etc.
 * Skips href/src/srcset/url() so brand swaps don't 404 cloned assets.
 */
export function applyTextSwap(
  html: string,
  from: string,
  to: string,
): { html: string; count: number } {
  if (!html || !from) return { html, count: 0 };
  const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi');
  let count = 0;
  const out = html.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (chunk) => {
    if (chunk.startsWith('<')) {
      return chunk.replace(
        /(\s(?:alt|title|aria-label|aria-roledescription|placeholder|content)\s*=\s*)(["'])([\s\S]*?)\2/gi,
        (_full, pre: string, q: string, val: string) => {
          const r = swapInText(val, re, to);
          count += r.count;
          return `${pre}${q}${r.text}${q}`;
        },
      );
    }
    const r = swapInText(chunk, re, to);
    count += r.count;
    return r.text;
  });
  return { html: out, count };
}

export function applyReplacementList(
  html: string,
  replacements: Array<{ from?: string; to?: string }>,
): { html: string; count: number } {
  let next = html;
  let count = 0;
  for (const item of replacements) {
    const from = String(item?.from || '').trim();
    const to = String(item?.to ?? '');
    if (from.length < 2) continue;
    const r = applyTextSwap(next, from, to);
    next = r.html;
    count += r.count;
  }
  return { html: next, count };
}

/** Unique visible text snippets for a patch-style LLM call (no full HTML). */
export function extractVisibleSnippets(html: string, max = 80): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = />([^<]{2,})</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const s = m[1].replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 180) continue;
    if (/^[{}[\].,;:%#\d\s/-]+$/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function isHugeAiHtml(html: string | null | undefined, tagName?: string | null): boolean {
  if (/^(main|body|html)$/i.test(String(tagName || ''))) return true;
  return (html?.length || 0) > LARGE_AI_HTML_CHARS;
}
