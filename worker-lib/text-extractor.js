// worker-lib/text-extractor.js
//
// Port JS puro di src/lib/universal-text-extractor.ts.
// Usato dal worker in-process, ZERO chiamate HTTP.
//
// Estrae tutti i testi visibili / meta / attributi / json-ld da un HTML.
// Mantenere allineato a src/lib/universal-text-extractor.ts: se cambia
// laggiu' (per la UI), rispecchia qui.

// ── JUNK FILTER: shipping country + currency selector items ─────
// Pattern emesso dai picker di shipping di Shopify/WooCommerce/Funnelish
// in footer:
//   "Bosnia & Herzegovina BAM KM"
//   "British Indian Ocean Territory USD $"
//   "Caribbean Netherlands USD $"
//   "Central African Republic XAF CFA"
//   "United States USD $"
// Sono ~250 stringhe auto-generate dalla piattaforma, ZERO valore di copy.
// Mandarli al LLM costa tempo e token. Filtrarli qui blocca tutto a monte.
//
// Heuristica conservativa:
//   - Comincia con MAIUSCOLA
//   - Non contiene punteggiatura di frase (. ! ? : ;)
//   - Non contiene cifre (cosi' "Get X — Just $39" passa)
//   - Lunghezza totale 6-70 char
//   - Finisce con: SPAZIO + 3-4 lettere maiuscole (codice valuta ISO 4217)
//     + SPAZIO + 1-6 caratteri non-spazio non-cifra (simbolo: $ € £ ¥, o
//     suffisso valuta: KM, kr, zł, CFA, FCFA, ecc.)
//
// Falsi positivi possibili teoricamente ma trascurabili: copy che finisce
// per ".. USD $" senza un punto prima ("Order processing in USD $")
// e' molto raro nelle landing.
// Trailing token: SIMBOLO valuta non-lettera ($ € £ ¥ ...) oppure
// 2-5 lettere MAIUSCOLE (KM, CFA, FCFA). Cosi' "Pricing in USD only"
// non viene erroneamente filtrato (trailing "only" e' lowercase).
// Trade-off: perdiamo i suffissi lowercase ("kr", "zł") ma sono rari
// nelle picker english-default e meno costosi di un falso positivo.
const COUNTRY_CURRENCY_RE = /^[A-ZÀÈÉÌÒÙÁÉÍÓÚÑ][A-Za-zÀ-ÿ\s&',()/.-]{3,55}\s[A-Z]{3,4}\s(?:[^\sa-zA-Z\d.!?:;]{1,6}|[A-Z]{2,5})$/;

function looksLikeCountryCurrencyPicker(s) {
  if (s.length < 8 || s.length > 70) return false;
  if (/[.!?:;]/.test(s)) return false;
  if (/\d/.test(s)) return false;
  return COUNTRY_CURRENCY_RE.test(s);
}

// ── BOILERPLATE TECNICO: filtri pre-LLM ─────────────────────────
// Pattern HTML/Shopify/Next.js che NON sono copy ma finiscono nei
// prompt e fanno "echare" il modello (= rispedisce identico
// l'originale). Senza questo filtro, il gap-fill perde 15-20 min su
// pagine medie ritentando questi id all'infinito (vedi log
// salvinilabs/adv9 18/05). Sono tutti "ZERO valore di copy", come
// i country-currency picker sopra.
//
// Pattern catturati:
//
//  1) META content tecnici:
//     "width=device-width,initial-scale=1" (viewport)
//     "IE=edge" (X-UA-Compatible)
//     "no-cache, no-store" (Cache-Control)
//     "text/html; charset=utf-8" (Content-Type)
//
//  2) URL path interi: "/96283164998/digital_wallets/dialog"
//     Tipico di Shopify Pay / Apple Pay / route SPA. L'extractor li
//     cattura quando finiscono in un attribute o in spa-json.
//
//  3) Hash hex / alfanumerici lunghi >= 24 char senza spazi:
//     "4e5323e83f88dbf4747a395309921945" (cart token)
//     "shop_pay_session_abc123..." (Shopify session)
//     UUID, build IDs Next.js, asset hashes.
//
//  4) Class/ID CSS DOM: token snake_case / kebab-case / camelCase
//     SENZA spazi e SENZA punteggiatura, lunghezza 4-40.
//     Esempi: "shopify-section-header", "cart_drawer_open",
//             "btn-primary--large".
//
// Heuristica conservativa: in dubbio, NON filtriamo (preferiamo che
// il LLM li veda piuttosto che droppare un copy reale per errore).
const META_TECHNICAL_RE = /^[a-zA-Z\-]+\s*=\s*[^,\s]+(?:\s*,\s*[a-zA-Z\-]+\s*=\s*[^,\s]+){0,4}$/;
const URL_PATH_RE = /^\/[A-Za-z0-9_\-/.~%]+$/;
const HASH_RE = /^[A-Za-z0-9_\-]{24,}$/;
const CSS_TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9]*(?:[-_]+[a-zA-Z0-9]+){1,8}$/;
// Lista CSV di token tecnici tipo Cache-Control / Content-Security-Policy:
// "no-cache,no-store", "default-src 'self'; script-src ...". I valori
// sono sempre lowercase + trattino, mai punteggiatura di frase.
const CSV_TECHNICAL_TOKENS_RE = /^[a-z][a-z0-9\-]{1,30}(?:\s*[,;]\s*[a-z][a-z0-9\-]{1,30}){1,8}$/;

function looksLikeTechnicalBoilerplate(s) {
  if (!s) return false;
  const len = s.length;
  if (len < 3) return false;
  if (URL_PATH_RE.test(s)) return true;
  if (HASH_RE.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s)) return true;
  // Pattern key=value: ammettiamo iniziali UPPERCASE (es. "IE=edge",
  // "X-UA-Compatible=IE=edge"), purche' contenga almeno un "=" preceduto
  // da una lettera (non confondibile con copy tipo "WAS $79" che non ha =).
  if (META_TECHNICAL_RE.test(s) && /[a-zA-Z][a-zA-Z\-]*=/.test(s)) return true;
  // CSV di token tecnici (Cache-Control / robots / CSP-like).
  if (CSV_TECHNICAL_TOKENS_RE.test(s)) return true;
  if (
    len >= 4 && len <= 50 &&
    !/\s/.test(s) &&
    !/[.!?:;,'"()[\]{}—–]/.test(s) &&
    CSS_TOKEN_RE.test(s)
  ) return true;
  return false;
}

// Context "meta:viewport" / "meta:charset" / "meta:robots" /
// "meta:generator" / "meta:theme-color" sono SEMPRE tecnici per
// definizione. Filtriamo a monte senza guardare il valore.
const META_TECHNICAL_KEYS = new Set([
  'meta:viewport',
  'meta:charset',
  'meta:robots',
  'meta:generator',
  'meta:theme-color',
  'meta:msapplication-tilecolor',
  'meta:msapplication-config',
  'meta:format-detection',
  'meta:apple-mobile-web-app-capable',
  'meta:apple-mobile-web-app-status-bar-style',
  'meta:referrer',
  'meta:google-site-verification',
  'meta:facebook-domain-verification',
  'meta:fb:app_id',
  'meta:fb:pages',
]);

function extractAllTextsUniversal(html) {
  const texts = [];
  const seen = new Set();
  let id = 0;

  function addText(text, context, position = 0) {
    const cleaned = String(text)
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2) return;
    if (looksLikeCountryCurrencyPicker(cleaned)) return;
    if (META_TECHNICAL_KEYS.has(context)) return;
    if (looksLikeTechnicalBoilerplate(cleaned)) return;
    const key = `${cleaned}::${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    texts.push({ id: id++, text: cleaned, context, position });
  }

  // 1. TITLE
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) addText(titleMatch[1], 'title', titleMatch.index || 0);

  // 2. META (con name/property)
  const metaRegex = /<meta\s+([^>]*?)>/gi;
  let metaMatch;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = metaMatch[1];
    const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
    if (!contentMatch) continue;
    const httpEquivMatch = attrs.match(/http-equiv=["']([^"']+)["']/i);
    if (httpEquivMatch) continue;
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    const propertyMatch = attrs.match(/property=["']([^"']+)["']/i);
    const key = (nameMatch?.[1] || propertyMatch?.[1] || '').toLowerCase();
    if (!key) continue;
    addText(contentMatch[1], `meta:${key}`, metaMatch.index);
  }

  // 3. tag semplici senza figli
  const simpleTagRegex = /<(\w+)([^>]*)>([^<]+)<\/\1>/gi;
  let simpleMatch;
  while ((simpleMatch = simpleTagRegex.exec(html)) !== null) {
    const tag = simpleMatch[1];
    const content = simpleMatch[3];
    addText(content, `tag:${tag}`, simpleMatch.index);
  }

  // 4. testi misti (tag spezzati)
  // Esteso da `p|div|li|td|th|h[1-6]|span|b|strong|em|i|a` per coprire i
  // tag che Nooro e altri lander SPA usano come contenitori di copy
  // con HTML annidato (es. <button><span>BUY</span></button>,
  // <header><h1>X</h1></header>, <section><div data-text>Y</div></section>,
  // <blockquote><p>testimonial</p></blockquote>, <label><span>Email</span></label>,
  // <figcaption>...</figcaption>). Prima questi venivano persi.
  const blockRegex = /<(p|div|li|td|th|h[1-6]|span|b|strong|em|i|a|button|header|footer|section|article|nav|aside|main|figcaption|caption|summary|label|blockquote|dt|dd)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let blockMatch;
  // BUG FIX (review-95 Nooro): l'HTML wrappava 6 bullet point dentro un
  // UNICO <i> esterno (4098 char totali). Il regex globale (lastIndex
  // avanzante) matchava il <i> esterno PER PRIMO e poi skippava tutti
  // i <span>/<b> interni → bullet "Achilles Tendinitis: Overpronation
  // can cause..." mai estratti → mai riscritti → "overpronation" restava
  // nei sub-bullet anche se il pair lungo del <i> esterno veniva droppato
  // dal cap length > 4000.
  // Soluzione: per ogni blocco LUNGO (>800 char), ricorri sull'innerHtml
  // con un secondo pass del blockRegex (depth=1) per catturare i
  // sub-elementi che il pass principale ha skippato. Limite di depth
  // a 2 per evitare infinite recursion in caso di HTML malformato.
  // IMPORTANTE: ogni chiamata ricorsiva istanzia una NUOVA RegExp.
  // Condividere la stessa RegExp tra chiamate ricorsive causerebbe
  // infinite loop perche' lastIndex viene resettato dalla ricorsione
  // e il while esterno ripartirebbe dall'inizio dell'inner.
  function harvestInnerBlocks(inner, baseIndex, depthLeft) {
    if (depthLeft <= 0) return;
    const localRegex = /<(p|div|li|td|th|h[1-6]|span|b|strong|em|i|a|button|header|footer|section|article|nav|aside|main|figcaption|caption|summary|label|blockquote|dt|dd)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let innerMatch;
    while ((innerMatch = localRegex.exec(inner)) !== null) {
      const innerTag = innerMatch[1];
      const innerInner = innerMatch[3];
      const innerPlain = innerInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (innerPlain.length > 2) {
        addText(innerPlain, `mixed:${innerTag}`, baseIndex + innerMatch.index);
      }
      // Ricorri sui blocchi ancora piu' lunghi (es. testimonial dentro
      // section dentro article).
      if (innerInner.length > 800 && /<[a-z]/i.test(innerInner)) {
        harvestInnerBlocks(innerInner, baseIndex + innerMatch.index, depthLeft - 1);
      }
    }
  }
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const tag = blockMatch[1];
    const innerHtml = blockMatch[3];
    const plainText = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plainText.length > 2) addText(plainText, `mixed:${tag}`, blockMatch.index);
    // Se il blocco e' lungo e contiene altri tag → ricorri per catturare
    // i sub-blocchi che il pass principale (lastIndex globale) skipperebbe.
    if (innerHtml.length > 800 && /<[a-z]/i.test(innerHtml)) {
      harvestInnerBlocks(innerHtml, blockMatch.index, 2);
    }
  }

  // 5. attributi
  const attrRegex = /\s(alt|title|placeholder|aria-label|value|data-text|data-title|data-content)=["']([^"']+)["']/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    addText(attrMatch[2], `attr:${attrMatch[1]}`, attrMatch.index);
  }

  // 6. URL
  const urlRegex = /\s(?:href|action)=["']([^"']+)["']/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html)) !== null) {
    addText(urlMatch[1], 'url', urlMatch.index);
  }

  // 7. email
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
  let emailMatch;
  while ((emailMatch = emailRegex.exec(html)) !== null) {
    addText(emailMatch[0], 'email', emailMatch.index);
  }

  // 8. JSON-LD (whitelist di chiavi semanticamente utili)
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  const usefulJsonLdKeys = new Set([
    'name','description','headline','alternativename','disambiguatingdescription',
    'caption','text','abstract','review','reviewbody','comment','slogan','keywords','genre','category',
  ]);
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(jsonLdMatch[1]);
      function visit(obj, path = '') {
        if (typeof obj === 'string') {
          const lastKey = (path.split('.').pop() || '').toLowerCase();
          if (usefulJsonLdKeys.has(lastKey) && obj.length >= 3 && obj.length < 1000 && /[a-zA-ZàèéìòùÀÈÉÌÒÙ]/.test(obj) && !/^https?:\/\//.test(obj)) {
            addText(obj, `json-ld:${lastKey}`, jsonLdMatch.index);
          }
        } else if (Array.isArray(obj)) {
          obj.forEach((item, i) => visit(item, `${path}[${i}]`));
        } else if (obj && typeof obj === 'object') {
          Object.entries(obj).forEach(([k, v]) => visit(v, path ? `${path}.${k}` : k));
        }
      }
      visit(jsonData);
    } catch {/* malformed JSON-LD, ignore */}
  }

  // 9. <noscript> content (testi visibili a screen reader / SEO bot)
  const noscriptRegex = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi;
  let noscriptMatch;
  while ((noscriptMatch = noscriptRegex.exec(html)) !== null) {
    const inner = noscriptMatch[1];
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length >= 2) addText(plain, 'noscript', noscriptMatch.index);
  }

  // 10. SPA JSON inline (Next.js __NEXT_DATA__, Nuxt __NUXT__, SvelteKit
  // __sveltekit_data, Remix __remixContext, ogni <script type="application/json">).
  // Su SPA che non hanno SSR dei tag visibili (quiz tipo Bioma, Typeform-like, ecc.)
  // i testi reali (domande, opzioni, label bottoni, headline, hero) vivono SOLO qui.
  // Filtro pesante per evitare ID / token / class / URL / path / colori.
  const spaJsonRegex = /<script\b[^>]*\stype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const usefulKeysSpa = new Set([
    'title','subtitle','heading','subheading','headline','tagline',
    'label','text','content','body','message','description',
    'placeholder','value','name','caption','copy','note','helptext',
    'question','questions','answer','answers','option','options',
    'choice','choices','button','buttontext','cta','ctatext',
    'submitlabel','nextlabel','backlabel','errormessage',
    'hero','subhero','benefit','benefits','feature','features',
    'testimonial','testimonials','faq','question_text','answer_text',
    'price','pricelabel','discount','badge','tag','eyebrow',
    'disclaimer','footer','legal',
  ]);
  const blacklistKeysSpa = new Set([
    'id','key','_id','uid','guid','slug','href','url','src',
    'image','imageurl','imagesrc','asset','avatar','icon','iconname',
    'type','kind','variant','classname','classnames','tag_name',
    'color','bgcolor','fontfamily','fontsize','theme',
    'aspath','path','route','pathname','search','query','querystring',
    'token','csrftoken','apikey','sessionid','visitorid',
    'event','eventname','analyticsid','gtmid','pixelid',
    'lang','locale','language','timezone','currency','country',
    'createdat','updatedat','timestamp','expiresat','date',
    'width','height','size','maxlength','minlength','min','max',
    'order','position','index','ordinal','step','count',
    'enabled','disabled','visible','hidden','required','active',
    'mime','mimetype','format','encoding','extension',
  ]);
  function looksLikeCode(s) {
    if (/^https?:\/\//i.test(s)) return true;
    if (/^data:[a-z]+\//i.test(s)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;
    if (/^[a-z][a-z0-9_-]{0,40}$/i.test(s) && s.length < 25 && !/\s/.test(s)) return true;
    if (/^[A-Z_]+$/.test(s) && s.length < 30) return true;
    if (/\{\{|\$\{|\bvar\b|\bfunction\b|\breturn\b|=>|\bconst\b|\blet\b/.test(s)) return true;
    if (/^[\d.,\s%/()\-+*=<>!?]+$/.test(s)) return true;
    return false;
  }
  function isHumanText(s) {
    // Cap 4000 (era 800): allineato a build-prompts.js. 4000 e' soglia
    // anti-JSON-dump (i pageData embedded sono 20k+), non filtro
    // qualitativo. Tutto il copy reale (anche testimonial estese)
    // sta sotto 4000.
    if (s.length < 3 || s.length > 4000) return false;
    const letters = s.match(/[a-zA-ZàèéìòùÀÈÉÌÒÙáéíóúÁÉÍÓÚñÑ]/g)?.length || 0;
    if (letters < 3) return false;
    if (letters / s.length < 0.4) return false;
    const words = s.trim().split(/\s+/);
    if (words.length === 1 && s.length < 4) return false;
    return true;
  }
  let spaJsonMatch;
  while ((spaJsonMatch = spaJsonRegex.exec(html)) !== null) {
    const rawJson = spaJsonMatch[1].trim();
    if (rawJson.length < 50) continue;
    let parsed;
    try { parsed = JSON.parse(rawJson); } catch { continue; }
    const seenInScript = new Set();
    function visitSpa(node, parentKey, depth) {
      if (depth > 25 || node == null) return;
      if (typeof node === 'string') {
        const lkey = (parentKey || '').toLowerCase();
        if (blacklistKeysSpa.has(lkey)) return;
        if (lkey.endsWith('id') || lkey.endsWith('url') || lkey.endsWith('src') || lkey.endsWith('href') || lkey.endsWith('class')) return;
        const trimmed = node.trim();
        if (!isHumanText(trimmed)) return;
        if (looksLikeCode(trimmed)) return;
        const useful = usefulKeysSpa.has(lkey)
          || /text|label|title|content|copy|description|question|answer|option|button|cta|message|hero|head/i.test(parentKey);
        if (!useful) {
          if (trimmed.length < 12 || !/\s/.test(trimmed)) return;
        }
        const dedupeKey = `${lkey}::${trimmed}`;
        if (seenInScript.has(dedupeKey)) return;
        seenInScript.add(dedupeKey);
        addText(trimmed, `spa-json:${lkey || 'value'}`, spaJsonMatch.index);
      } else if (Array.isArray(node)) {
        for (const item of node) visitSpa(item, parentKey, depth + 1);
      } else if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) visitSpa(v, k, depth + 1);
      }
    }
    visitSpa(parsed, '', 0);
  }

  // 11. stringhe letterali negli <script> non-JSON (loose, last-resort)
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1];
    // Skip se contiene una marker tipico SPA: gia' coperto sopra
    if (/^\s*\{[\s\S]*\}\s*$/.test(content.trim())) continue;
    const stringRegex = /["']([^"']{2,200})["']/g;
    let sm;
    while ((sm = stringRegex.exec(content)) !== null) {
      const str = sm[1];
      if (/[a-zA-Z\s]{3,}/.test(str) && !/[{}();=<>]/.test(str)) {
        addText(str, 'script:string', scriptMatch.index);
      }
    }
  }

  // 12. telefoni
  const phoneRegex = /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  let phoneMatch;
  while ((phoneMatch = phoneRegex.exec(html)) !== null) {
    if (phoneMatch[0].length >= 10) addText(phoneMatch[0], 'phone', phoneMatch.index);
  }

  return texts;
}

module.exports = { extractAllTextsUniversal };
