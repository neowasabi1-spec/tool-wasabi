// Client-side HTML translate context.
//
// Strategia: NON facciamo piu' replace su stringa HTML. Costruiamo un
// "context" che parsea l'HTML una volta sola in DOM, registra ogni text
// node + ogni attributo traducibile, e quando l'utente chiama `apply()`
// modifica i nodi in-place e serializza. In questo modo:
//
// - Niente match falliti per whitespace/encoding (il problema piu'
//   comune del vecchio applyTranslationsToHtml su stringa).
// - Niente match mancato per smart quote vs straight quote, em-dash,
//   NBSP, entita' numeriche `&#8217;` → `'`, etc.: il DOM aveva gia'
//   normalizzato tutto.
// - Stesse occorrenze multiple ("Buy now" 12 volte nella pagina) vengono
//   tradotte tutte automaticamente con UNA sola call a Claude (dedup
//   per testo pulito).
// - Preserviamo leading/trailing whitespace di ogni text node, cosi'
//   l'indentazione e i ritorni a capo originali non vengono persi.

export interface ExtractedText {
  id: number;
  text: string; // testo pulito da mandare a Claude
  tag: string;  // contesto sintattico (h1, button, attr:alt, meta:description, ...)
}

export interface TranslateContext {
  texts: ExtractedText[];
  apply(
    translations: Map<number, string>,
    targetLanguage: string,
  ): { html: string; replacements: number; missed: number };
}

const SKIP_PARENT_TAGS = new Set([
  'script', 'style', 'noscript', 'template',
  'code', 'pre', 'kbd', 'samp', 'var', 'tt',
]);

const ATTR_NAMES = ['alt', 'title', 'placeholder', 'aria-label'] as const;

const ALLOWED_META_KEYS = new Set([
  'description', 'keywords',
  'og:title', 'og:description', 'og:site_name',
  'twitter:title', 'twitter:description',
  'application-name', 'apple-mobile-web-app-title',
]);

// Cap su testi UNICI (dopo dedup). 2500 e' largo per landing reali;
// limite serve solo a tagliare patologie (pagine con migliaia di
// boilerplate identici tipo cookies/legal in un loop).
const MAX_UNIQUE_TEXTS = 2500;

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
      'sample text', 'click here', 'true', 'false', 'undefined', 'null',
    ].includes(lower)
  ) {
    return false;
  }
  if (/^[{};:|()<>=]+$/.test(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  return true;
}

function langCodeFor(targetLanguage: string): string {
  const tl = (targetLanguage || '').trim().toLowerCase();
  return LANG_MAP[tl] || tl.slice(0, 2) || 'en';
}

// =====================================================================
// REGEX FALLBACK (usato solo SSR/Node, dove DOMParser non esiste).
// Implementa la stessa interfaccia ma funziona su stringa.
// =====================================================================

function regexFallbackContext(html: string): TranslateContext {
  // In SSR non abbiamo modo di mutare il DOM, quindi ritorniamo un context
  // degenere: testi vuoti → l'utente non chiamera' Claude. La translate
  // e' UI-flow, quindi parte sempre dal browser comunque.
  return {
    texts: [],
    apply: (_translations, targetLanguage) => {
      let out = html;
      const langCode = langCodeFor(targetLanguage);
      if (!/<html\b[^>]*\blang=/i.test(out)) {
        out = out.replace(/<html\b/i, `<html lang="${langCode}"`);
      } else {
        out = out.replace(/<html\b([^>]*)\blang=["'][^"']*["']/i, `<html$1lang="${langCode}"`);
      }
      return { html: out, replacements: 0, missed: 0 };
    },
  };
}

// =====================================================================
// DOM-BASED CONTEXT (browser).
// =====================================================================

export function buildTranslateContext(html: string): TranslateContext {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return regexFallbackContext(html);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // DOCTYPE non viene preservato in `documentElement.outerHTML`. Lo recuperiamo
  // dalla stringa originale (o ne forziamo uno HTML5 di default).
  const doctypeMatch = html.match(/^\s*<!DOCTYPE[^>]*>/i);
  const doctype = doctypeMatch ? doctypeMatch[0] : '<!DOCTYPE html>';

  type TextRefBase = { id: number; clean: string; tag: string };
  type TextRef =
    | (TextRefBase & { type: 'text'; node: Text })
    | (TextRefBase & { type: 'attr'; node: Element; attrName: string });

  const refs: TextRef[] = [];
  const cleanToId = new Map<string, number>();
  const idToInfo = new Map<number, { clean: string; tag: string }>();
  let nextId = 0;

  // Restituisce un id (esistente o nuovo) per il testo pulito,
  // null se siamo oltre il cap MAX_UNIQUE_TEXTS.
  const getId = (clean: string, tag: string): number | null => {
    const existing = cleanToId.get(clean);
    if (existing !== undefined) return existing;
    if (cleanToId.size >= MAX_UNIQUE_TEXTS) return null;
    const id = nextId++;
    cleanToId.set(clean, id);
    idToInfo.set(id, { clean, tag });
    return id;
  };

  // 1) Tutti i text node visibili (inclusi <title>, dato che usiamo
  //    documentElement come root invece di body).
  const root = doc.documentElement;
  if (root) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (parent) {
        const parentTag = parent.tagName.toLowerCase();
        if (!SKIP_PARENT_TAGS.has(parentTag)) {
          const raw = textNode.data;
          const clean = cleanText(raw);
          if (isTranslatableText(clean)) {
            const id = getId(clean, parentTag);
            if (id !== null) {
              refs.push({ type: 'text', node: textNode, clean, tag: parentTag, id });
            }
          }
        }
      }
      node = walker.nextNode();
    }
  }

  // 2) Meta tags rilevanti (description, og:*, twitter:*, ...)
  doc.querySelectorAll('meta').forEach((meta) => {
    if (meta.getAttribute('http-equiv')) return;
    const key = (
      meta.getAttribute('name') ||
      meta.getAttribute('property') ||
      ''
    ).toLowerCase();
    if (!ALLOWED_META_KEYS.has(key)) return;
    const content = meta.getAttribute('content');
    if (!content) return;
    const clean = cleanText(content);
    if (!isTranslatableText(clean)) return;
    const tag = `meta:${key}`;
    const id = getId(clean, tag);
    if (id !== null) {
      refs.push({ type: 'attr', node: meta, attrName: 'content', clean, tag, id });
    }
  });

  // 3) Attributi traducibili su qualsiasi elemento
  for (const attr of ATTR_NAMES) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      // Skip su elementi che skippiamo anche per text content
      const elTag = el.tagName.toLowerCase();
      if (SKIP_PARENT_TAGS.has(elTag)) return;
      const value = el.getAttribute(attr);
      if (!value) return;
      const clean = cleanText(value);
      if (!isTranslatableText(clean)) return;
      const tag = `attr:${attr}`;
      const id = getId(clean, tag);
      if (id !== null) {
        refs.push({ type: 'attr', node: el, attrName: attr, clean, tag, id });
      }
    });
  }

  const texts: ExtractedText[] = Array.from(idToInfo.entries()).map(
    ([id, info]) => ({ id, text: info.clean, tag: info.tag }),
  );

  const apply: TranslateContext['apply'] = (translations, targetLanguage) => {
    let replacements = 0;
    let missed = 0;

    for (const ref of refs) {
      const translated = translations.get(ref.id);
      if (!translated || translated.trim() === ref.clean) {
        missed += 1;
        continue;
      }
      const trimmed = translated.trim();

      if (ref.type === 'text') {
        // Preserva eventuali whitespace di leading/trailing del text node:
        // serve a non distruggere la formattazione (es. spazio tra
        // "<strong>X</strong> y" che e' un text node " y" iniziale).
        const data = ref.node.data;
        const leadMatch = data.match(/^\s*/);
        const trailMatch = data.match(/\s*$/);
        const leading = leadMatch ? leadMatch[0] : '';
        const trailing = trailMatch ? trailMatch[0] : '';
        ref.node.data = leading + trimmed + trailing;
      } else {
        ref.node.setAttribute(ref.attrName, trimmed);
      }
      replacements += 1;
    }

    // Imposta lang attribute sull'<html>
    const langCode = langCodeFor(targetLanguage);
    doc.documentElement.setAttribute('lang', langCode);

    const serialized = `${doctype}\n${doc.documentElement.outerHTML}`;
    return { html: serialized, replacements, missed };
  };

  return { texts, apply };
}
