// Client-side HTML text extraction + replacement for the Translate flow.
//
// Perche' lato client:
// - le landing page reali hanno 200-600 testi traducibili. Lavorando
//   tutto dentro la Edge Function, il loop di chiamate a Claude
//   superava il timeout dei proxy intermedi (Netlify / Cloudflare /
//   Supabase TLS terminator) e il browser riceveva HTML 504
//   `Inactivity Timeout` invece di JSON.
// - Spezzando lato client, ogni call all'Edge Function dura 10-30s
//   (un solo batch a Claude) e nessun proxy taglia la connessione.
// - Bonus: progress bar reale, retry per-batch, applicazione delle
//   traduzioni offline sul HTML giâ in memoria.
//
// L'algoritmo di estrazione e replace specchia 1:1 quello che era
// dentro la Edge Function (ora dimezzata in modalita' batch-only),
// quindi i testi che il client estrae sono esattamente quelli che la
// function avrebbe estratto prima del refactor.

export interface ExtractedText {
  id: number;
  text: string;
  tag: string;
}

const TEXT_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'td', 'th', 'dt', 'dd',
  'button', 'a', 'label', 'figcaption',
  'blockquote', 'summary', 'legend',
  'span', 'strong', 'em', 'b', 'i', 'u',
];

const ATTR_TEXTS = ['alt', 'title', 'placeholder', 'aria-label'];

const MAX_TEXTS = 800;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function encodeHtmlEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanText(s: string): string {
  return decodeHtmlEntities(s).replace(/\s+/g, ' ').trim();
}

function isTranslatableText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (t.length > 4000) return false;
  if (/^[\s\d.,$€£¥%+\-/*()[\]{}|\\!?:;<>="'#@&_]+$/.test(t)) return false;
  if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(t)) return false;
  if (/^\s*\{%[\s\S]*%\}\s*$/.test(t)) return false;
  if (/^\s*\$\{[\s\S]*\}\s*$/.test(t)) return false;
  const lower = t.toLowerCase();
  if (
    [
      'text', 'title', 'link', 'button', 'image', 'submit',
      'placeholder', 'none', 'default', 'block', 'lorem ipsum',
      'sample text', 'click here', 'true', 'false',
    ].includes(lower)
  ) {
    return false;
  }
  if (/^[{};:|()<>=]+$/.test(t)) return false;
  return true;
}

export function extractTextsForTranslate(html: string): ExtractedText[] {
  const out: ExtractedText[] = [];
  const seen = new Set<string>();
  let nextId = 0;

  const push = (text: string, tag: string) => {
    const cleaned = cleanText(text);
    if (!isTranslatableText(cleaned)) return;
    const key = `${tag}::${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: nextId++, text: cleaned, tag });
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) push(titleMatch[1], 'title');

  const allowedMeta = new Set([
    'description',
    'og:title', 'og:description', 'og:site_name',
    'twitter:title', 'twitter:description',
  ]);
  const metaRegex = /<meta\s+([^>]+?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRegex.exec(html)) !== null) {
    if (out.length >= MAX_TEXTS) break;
    const attrs = m[1];
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    if (!contentMatch) continue;
    if (/http-equiv=/i.test(attrs)) continue;
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    const propMatch = attrs.match(/property=["']([^"']+)["']/i);
    const key = (nameMatch?.[1] || propMatch?.[1] || '').toLowerCase();
    if (!allowedMeta.has(key)) continue;
    push(contentMatch[1], `meta:${key}`);
  }

  for (const tag of TEXT_TAGS) {
    if (out.length >= MAX_TEXTS) break;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html)) !== null) {
      if (out.length >= MAX_TEXTS) break;
      const inner = mm[1];
      const hasBlockChild = /<(?:p|li|h[1-6]|button|a|td|th|figcaption|blockquote)\b/i.test(inner);
      if (hasBlockChild) continue;
      const text = inner.replace(/<[^>]+>/g, ' ');
      push(text, tag);
    }
  }

  for (const attr of ATTR_TEXTS) {
    if (out.length >= MAX_TEXTS) break;
    const re = new RegExp(`${attr}=["']([^"']+)["']`, 'gi');
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html)) !== null) {
      if (out.length >= MAX_TEXTS) break;
      push(mm[1], `attr:${attr}`);
    }
  }

  return out;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyTranslationsToHtml(
  html: string,
  pairs: Array<{ original: string; translated: string }>,
): { html: string; replacements: number } {
  let out = html;
  let replacements = 0;
  // Piu' lunghi prima per evitare che "ciao" sostituisca dentro "ciao mondo"
  const sorted = [...pairs].sort((a, b) => b.original.length - a.original.length);

  for (const { original, translated } of sorted) {
    if (!original || !translated || original === translated) continue;
    const encOrig = encodeHtmlEntities(original);
    const encTrans = encodeHtmlEntities(translated);
    if (encOrig.length >= 2) {
      const re1 = new RegExp(escapeForRegex(encOrig), 'g');
      const before = out;
      out = out.replace(re1, encTrans);
      if (out !== before) replacements += 1;
    }
    if (original !== encOrig && original.length >= 2) {
      const re2 = new RegExp(escapeForRegex(original), 'g');
      const before = out;
      out = out.replace(re2, translated);
      if (out !== before) replacements += 1;
    }
  }
  return { html: out, replacements };
}

// Annotazione lang attribute (best effort) sull'<html>.
// Es: targetLanguage="English" -> lang="en"
export function setHtmlLangAttr(html: string, targetLanguage: string): string {
  const langCode = (targetLanguage || '').toLowerCase().slice(0, 2) || 'en';
  if (!/<html\b[^>]*\blang=/i.test(html)) {
    return html.replace(/<html\b/i, `<html lang="${langCode}"`);
  }
  return html.replace(/<html\b([^>]*)\blang=["'][^"']*["']/i, `<html$1lang="${langCode}"`);
}
