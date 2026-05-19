// Client-side HTML text extraction + replacement for the Translate flow.
//
// Estrazione DOM-based (DOMParser + TreeWalker) — molto piu' robusta del
// regex-based extractor precedente, che saltava div/section/article puri,
// elementi profondamente annidati e mixed-content (`<p>parte <span>X</span>
// parte</p>` faceva skip per "block child"). Ora prendiamo OGNI text node
// visibile + attributi traducibili + meta tags + title.
//
// Replace whitespace-tolerant — il vecchio replace cercava il testo
// `cleanText`-ato (whitespace normalizzato) dentro l'HTML originale che
// invece poteva avere `\n` e indentazione. Risultato: Claude traduceva
// correttamente ma il replace falliva silenziosamente. Ora il regex
// converte ogni run di whitespace in `\s+` e prova varianti encoded/raw.

export interface ExtractedText {
  id: number;
  text: string; // cleaned, e' quello che mandiamo a Claude
  raw: string;  // raw text con whitespace originale, usato per replace
  tag: string;  // contesto sintattico per Claude (h1, button, attr:alt, ...)
}

const SKIP_PARENT_TAGS = new Set([
  'script', 'style', 'noscript', 'template',
  'code', 'pre', 'kbd', 'samp', 'var', 'tt',
]);

const ATTR_TEXTS = ['alt', 'title', 'placeholder', 'aria-label'] as const;

const ALLOWED_META_KEYS = new Set([
  'description',
  'keywords',
  'og:title', 'og:description', 'og:site_name',
  'twitter:title', 'twitter:description',
  'application-name', 'apple-mobile-web-app-title',
]);

// Cap molto piu' largo del precedente (800). Le landing reali hanno 200-600
// testi traducibili; qualche outlier puo' arrivare a 1500. Sopra 2500 entriamo
// in zona di rischio sui costi Claude — meglio bloccare e segnalare.
const MAX_TEXTS = 2500;

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
  // Solo numeri, simboli, punteggiatura → non traducibile
  if (/^[\s\d.,$€£¥%+\-/*()[\]{}|\\!?:;<>="'#@&_]+$/.test(t)) return false;
  // Template placeholder
  if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(t)) return false;
  if (/^\s*\{%[\s\S]*%\}\s*$/.test(t)) return false;
  if (/^\s*\$\{[\s\S]*\}\s*$/.test(t)) return false;
  // Token tipici di placeholder generici
  const lower = t.toLowerCase();
  if (
    [
      'text', 'title', 'link', 'button', 'image', 'submit',
      'placeholder', 'none', 'default', 'block', 'lorem ipsum',
      'sample text', 'click here', 'true', 'false', 'undefined', 'null',
    ].includes(lower)
  ) {
    return false;
  }
  if (/^[{};:|()<>=]+$/.test(t)) return false;
  // Almeno una lettera (qualsiasi alfabeto). Senza lettere, niente da tradurre.
  if (!/\p{L}/u.test(t)) return false;
  return true;
}

// Fallback regex extractor (usato solo in SSR/Node dove DOMParser non esiste)
function extractTextsRegexFallback(html: string): ExtractedText[] {
  const out: ExtractedText[] = [];
  const seen = new Set<string>();
  let nextId = 0;

  const push = (raw: string, tag: string) => {
    const cleaned = cleanText(raw);
    if (!isTranslatableText(cleaned)) return;
    const key = `${tag}::${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: nextId++, text: cleaned, raw, tag });
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) push(titleMatch[1], 'title');

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
    if (!ALLOWED_META_KEYS.has(key)) continue;
    push(contentMatch[1], `meta:${key}`);
  }

  // Tutti i tag con testo (non perfetto ma copre la maggioranza)
  const TEXT_TAGS = [
    'h1','h2','h3','h4','h5','h6',
    'p','li','td','th','dt','dd',
    'button','a','label','figcaption',
    'blockquote','summary','legend','caption',
    'span','strong','em','b','i','u','small','mark','ins','del','sub','sup',
    'div','section','article','header','footer','aside','main','nav',
  ];
  for (const tag of TEXT_TAGS) {
    if (out.length >= MAX_TEXTS) break;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html)) !== null) {
      if (out.length >= MAX_TEXTS) break;
      const inner = mm[1];
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

export function extractTextsForTranslate(html: string): ExtractedText[] {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return extractTextsRegexFallback(html);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const out: ExtractedText[] = [];
  const seen = new Set<string>();
  let nextId = 0;

  const push = (raw: string, tag: string) => {
    const cleaned = cleanText(raw);
    if (!isTranslatableText(cleaned)) return;
    // Dedup per (tag, testo) — evita di mandare 50 volte lo stesso "Buy now"
    const key = `${tag}::${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: nextId++, text: cleaned, raw, tag });
  };

  // 1) <title>
  const titleEl = doc.querySelector('title');
  if (titleEl?.textContent) push(titleEl.textContent, 'title');

  // 2) <meta> rilevanti
  const metas = doc.querySelectorAll('meta');
  metas.forEach((meta) => {
    if (out.length >= MAX_TEXTS) return;
    if (meta.getAttribute('http-equiv')) return;
    const key = (
      meta.getAttribute('name') ||
      meta.getAttribute('property') ||
      ''
    ).toLowerCase();
    if (!ALLOWED_META_KEYS.has(key)) return;
    const content = meta.getAttribute('content');
    if (content) push(content, `meta:${key}`);
  });

  // 3) Walk di tutti i text node visibili
  // Body + head, ma il body e' dove vive il contenuto. Per i text node nel
  // <head> ci pensa la sezione meta/title sopra.
  const root = doc.body || doc.documentElement;
  if (root) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node && out.length < MAX_TEXTS) {
      const parent = (node as Text).parentElement;
      if (parent) {
        const parentTag = parent.tagName.toLowerCase();
        if (!SKIP_PARENT_TAGS.has(parentTag)) {
          const raw = (node as Text).data;
          if (raw && raw.trim().length >= 2) {
            push(raw, parentTag);
          }
        }
      }
      node = walker.nextNode();
    }
  }

  // 4) Attributi traducibili (alt/title/placeholder/aria-label) su qualsiasi elemento
  for (const attr of ATTR_TEXTS) {
    if (out.length >= MAX_TEXTS) break;
    const els = doc.querySelectorAll(`[${attr}]`);
    els.forEach((el) => {
      if (out.length >= MAX_TEXTS) return;
      const value = el.getAttribute(attr);
      if (value) push(value, `attr:${attr}`);
    });
  }

  return out;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Costruisce un pattern regex che matcha la stringa originale ma con
// whitespace flessibile: ogni run di spazi/tab/newline/nbsp diventa `\s+`.
// Cosi' "Hello world" matcha anche "Hello\n  world" e "Hello&nbsp;world"
// (dopo decode entita'), che e' la causa principale dei testi non tradotti.
function buildWhitespaceTolerantPattern(s: string): string {
  // Split su run di whitespace, escapa i pezzi, riunisci con \s+
  const parts = s.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return escapeForRegex(s);
  return parts.map(escapeForRegex).join('\\s+');
}

// Sostituisce il primo match (o tutti) del pattern, restituendo il numero
// di replace fatti.
function tryReplace(
  haystack: string,
  pattern: RegExp,
  replacement: string,
): { html: string; count: number } {
  let count = 0;
  const html = haystack.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { html, count };
}

export interface TranslatePair {
  raw: string;        // testo originale come e' nel text node (con whitespace)
  clean: string;      // testo pulito (quello mandato a Claude)
  translated: string; // traduzione restituita da Claude
}

export function applyTranslationsToHtml(
  html: string,
  pairs: TranslatePair[],
): { html: string; replacements: number; missed: number } {
  let out = html;
  let replacements = 0;
  let missed = 0;

  // Piu' lunghi prima — evita che "Buy" sostituisca dentro "Buy now bundle"
  const sorted = [...pairs].sort(
    (a, b) => b.clean.length + b.raw.length - (a.clean.length + a.raw.length),
  );

  for (const { raw, clean, translated } of sorted) {
    if (!translated || (raw === translated && clean === translated)) continue;
    const tTrim = translated.trim();
    if (!tTrim) continue;

    const candidates: string[] = [];
    // Ordine di tentativi: piu' specifico → piu' tollerante
    if (raw && raw !== clean) candidates.push(raw);
    if (raw) candidates.push(encodeHtmlEntities(raw));
    if (clean) candidates.push(clean);
    if (clean) candidates.push(encodeHtmlEntities(clean));
    // Dedup mantenendo ordine
    const tried = new Set<string>();

    let didReplace = false;

    // Tentativo 1-4: match esatto
    for (const cand of candidates) {
      if (!cand || cand.length < 2 || tried.has(cand)) continue;
      tried.add(cand);
      const re = new RegExp(escapeForRegex(cand), 'g');
      // Stesso encoding del candidato per la sostituzione
      const replacement = cand === encodeHtmlEntities(clean) || cand === encodeHtmlEntities(raw)
        ? encodeHtmlEntities(tTrim)
        : tTrim;
      const result = tryReplace(out, re, replacement);
      if (result.count > 0) {
        out = result.html;
        replacements += result.count;
        didReplace = true;
        break;
      }
    }
    if (didReplace) continue;

    // Tentativo 5-6: whitespace-tolerant (encoded e raw)
    for (const cand of [encodeHtmlEntities(clean), clean]) {
      if (!cand || !/\s/.test(cand)) continue;
      const pattern = buildWhitespaceTolerantPattern(cand);
      const re = new RegExp(pattern, 'g');
      const replacement = cand === encodeHtmlEntities(clean)
        ? encodeHtmlEntities(tTrim)
        : tTrim;
      const result = tryReplace(out, re, replacement);
      if (result.count > 0) {
        out = result.html;
        replacements += result.count;
        didReplace = true;
        break;
      }
    }

    if (!didReplace) missed += 1;
  }

  return { html: out, replacements, missed };
}

// Annotazione lang attribute (best effort) sull'<html>.
// Es: targetLanguage="English" -> lang="en"
const LANG_MAP: Record<string, string> = {
  english: 'en',
  italian: 'it', italiano: 'it',
  french: 'fr', français: 'fr', francese: 'fr',
  spanish: 'es', español: 'es', spagnolo: 'es',
  german: 'de', deutsch: 'de', tedesco: 'de',
  portuguese: 'pt', português: 'pt', portoghese: 'pt',
  dutch: 'nl', nederlands: 'nl', olandese: 'nl',
  polish: 'pl', polski: 'pl', polacco: 'pl',
  russian: 'ru', русский: 'ru', russo: 'ru',
  japanese: 'ja', 日本語: 'ja', giapponese: 'ja',
  chinese: 'zh', 中文: 'zh', cinese: 'zh',
  korean: 'ko', 한국어: 'ko', coreano: 'ko',
  arabic: 'ar', العربية: 'ar', arabo: 'ar',
  turkish: 'tr', türkçe: 'tr', turco: 'tr',
};

export function setHtmlLangAttr(html: string, targetLanguage: string): string {
  const tl = (targetLanguage || '').trim().toLowerCase();
  const langCode = LANG_MAP[tl] || tl.slice(0, 2) || 'en';
  if (!/<html\b[^>]*\blang=/i.test(html)) {
    return html.replace(/<html\b/i, `<html lang="${langCode}"`);
  }
  return html.replace(/<html\b([^>]*)\blang=["'][^"']*["']/i, `<html$1lang="${langCode}"`);
}
