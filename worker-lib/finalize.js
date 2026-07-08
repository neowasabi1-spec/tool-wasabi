// worker-lib/finalize.js
//
// Port JS puro di src/app/api/landing/swipe/openclaw-finalize/route.ts.
// Applica i rewrite all'HTML originale ZERO chiamate HTTP a Netlify.
//
// Input:
//   { html, sourceUrl?, texts: [{id,original,tag}], rewrites: [{id,rewritten}] }
// Output: stessa shape che ritornava la route Netlify.

const { detectDynamicScripts } = require('./detect-dynamic-scripts');
const { neutralizeRocketLoader } = require('./neutralize-rocket-loader');
const { applyTimedCommentRewrites } = require('./timed-comments');

function escRxLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Distribuisce `newText` proporzionalmente tra i segmenti di testo `textSegments`
// (riferimenti index nell'array `segments` derivato da split('/(<[^>]+>)/')),
// preservando la posizione e la quantita' relativa dei tag inline (bold, link,
// br, ecc.). Porting dell'algoritmo della Deno function clone-competitor.
function distributeTextProportionally(segments, textSegments, newText) {
  if (textSegments.length <= 1) {
    if (textSegments.length === 1) segments[textSegments[0].index] = newText;
    return;
  }
  const originalWordCounts = textSegments.map((ts) => {
    const words = ts.content.trim().split(/\s+/).filter((w) => w.length > 0);
    return Math.max(1, words.length);
  });
  const totalOriginalWords = originalWordCounts.reduce((a, b) => a + b, 0);
  const newWords = newText.trim().split(/\s+/).filter((w) => w.length > 0);
  if (totalOriginalWords === 0 || newWords.length === 0) {
    segments[textSegments[0].index] = newText;
    for (let si = 1; si < textSegments.length; si++) segments[textSegments[si].index] = '';
    return;
  }
  let wordIdx = 0;
  for (let si = 0; si < textSegments.length; si++) {
    const cumulativeRatio =
      originalWordCounts.slice(0, si + 1).reduce((a, b) => a + b, 0) / totalOriginalWords;
    const cumulativeTarget = Math.round(cumulativeRatio * newWords.length);
    const wordsForThis = Math.max(0, cumulativeTarget - wordIdx);
    if (wordsForThis > 0 && wordIdx < newWords.length) {
      const segmentWords = newWords.slice(wordIdx, wordIdx + wordsForThis).join(' ');
      const hadLeadingSpace = /^\s/.test(textSegments[si].content);
      segments[textSegments[si].index] = (hadLeadingSpace && si > 0 ? ' ' : '') + segmentWords;
      wordIdx += wordsForThis;
    } else {
      segments[textSegments[si].index] = '';
    }
  }
  if (wordIdx < newWords.length) {
    const lastIdx = textSegments[textSegments.length - 1].index;
    const remaining = newWords.slice(wordIdx).join(' ');
    segments[lastIdx] = segments[lastIdx] ? segments[lastIdx] + ' ' + remaining : remaining;
  }
}

// Sostituisce placeholder Liquid/Jinja noti con valori reali. Senza questa
// pass, "{{MMMM dd, yyyy}}", "{{Location}}" restano letterali nel preview.
function replaceLiquidPlaceholders(html) {
  const now = new Date();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fullDate = `${monthNames[now.getMonth()]} ${String(now.getDate()).padStart(2,'0')}, ${now.getFullYear()}`;
  const shortDate = `${monthShort[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  return html
    .replace(/\{\{\s*MMMM\s+dd,?\s+yyyy\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*MMM\s+dd,?\s+yyyy\s*\}\}/gi, shortDate)
    .replace(/\{\{\s*dd[\/\-]MM[\/\-]yyyy\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*yyyy[\/\-]MM[\/\-]dd\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*today\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*current[\s_-]?date\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*day[\s_-]?name\s*\}\}/gi, dayName)
    .replace(/\{\{\s*[Ll]ocation\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ity\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ountry\s*\}\}/g, '');
}

// Fuzzy replace tag-tolerante: prova a trovare l'originale anche quando in
// HTML e' spezzato da tag inline (<strong>, <em>, <span>, <br>, ecc.) o
// contiene &nbsp;. Quando trova un match, distribuisce il nuovo testo
// proporzionalmente sui segmenti di testo preservando ESATTAMENTE i tag.
// Ritorna { html, replaced } con replaced=true se almeno un'occorrenza e'
// stata sostituita.
function fuzzyReplaceWithTagPreservation(html, originalText, newText) {
  if (!originalText || !newText || originalText === newText) return { html, replaced: false };
  // Cap length 1500 (era 600): coerente con il nuovo cap dei testi a 4000.
  // A 600 i testi medio-lunghi (es. paragrafo con 1 frase di brand + 1
  // frase di feature + 1 frase di benefit) che hanno tag inline annidati
  // non venivano MAI fuzzy-matchati e restavano con i pezzi originali.
  if (originalText.length < 5 || originalText.length > 1500) return { html, replaced: false };
  const words = originalText.split(/\s+/).filter((w) => w.length > 0);
  // Cap word 60 (era 40): vedi sopra.
  if (words.length < 2 || words.length > 60) return { html, replaced: false };
  let result = html;
  let replaced = false;
  try {
    const escapedWords = words.map((w) => escRxLiteral(w));
    const tagsBetween = '(?:\\s|&nbsp;|<[^>]{0,200}>)*';
    const pattern = escapedWords.join(tagsBetween);
    const regex = new RegExp(pattern, 'i');
    const match = result.match(regex);
    if (match) {
      const matchedStr = match[0];
      const tagsInMatch = matchedStr.match(/<[^>]+>/g) || [];
      if (tagsInMatch.length > 0) {
        const segments = matchedStr.split(/(<[^>]+>)/);
        const textSegments = [];
        for (let si = 0; si < segments.length; si++) {
          if (segments[si] && !segments[si].startsWith('<')) {
            textSegments.push({ index: si, content: segments[si] });
          }
        }
        if (textSegments.length > 0) {
          distributeTextProportionally(segments, textSegments, newText);
          const replacement = segments.join('');
          result = result.substring(0, match.index) + replacement + result.substring(match.index + matchedStr.length);
          replaced = true;
        } else {
          const preservedTags = tagsInMatch.join('');
          result = result.substring(0, match.index) + newText + preservedTags + result.substring(match.index + matchedStr.length);
          replaced = true;
        }
      } else {
        result = result.substring(0, match.index) + newText + result.substring(match.index + matchedStr.length);
        replaced = true;
      }
    }
  } catch { /* regex invalida (improbabile, escape ok), skip */ }
  return { html: result, replaced };
}

// Estrae candidati brand dal dominio: try.nooro-us.com → ['nooro-us','nooro','us']
function extractBrandCandidatesFromDomain(sourceUrl) {
  const out = [];
  if (!sourceUrl) return out;
  try {
    const urlObj = new URL(sourceUrl);
    const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
    const parts = host.split('.');
    const twoLevelTlds = new Set(['co.uk','co.nz','com.au','com.br','co.jp','co.in']);
    let sldIdx = parts.length - 2;
    if (parts.length >= 3 && twoLevelTlds.has(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`)) {
      sldIdx = parts.length - 3;
    }
    const sld = parts[sldIdx];
    if (sld && sld.length >= 3) {
      out.push(sld);
      if (sld.includes('-')) for (const piece of sld.split('-')) if (piece.length >= 3) out.push(piece);
    }
    for (let i = 0; i < sldIdx; i++) {
      const sub = parts[i];
      if (sub.length >= 4 && !['try','app','www','shop','store','go','buy','get','my','web'].includes(sub)) {
        out.push(sub);
      }
    }
  } catch {/* invalid url */}
  return out;
}

// Sostituisce il brand del competitor (estratto dal dominio e dal <title>
// originale) con il nuovo nome prodotto, SOLO nei text-node (non in style/
// script/noscript) e con guard sui TLD per non rompere URL.
function replaceBrandInHtml(html, sourceUrl, originalHtml, productName) {
  if (!productName || !sourceUrl) return html;
  const brandsToReplace = [];
  brandsToReplace.push(...extractBrandCandidatesFromDomain(sourceUrl));
  const titleMatch = (originalHtml || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const titleParts = titleMatch[1].trim().split(/\s*[-|:–—]\s*/);
    for (const part of titleParts) {
      const t = part.trim();
      if (t.length > 3 && t.length < 40 && t.toLowerCase() !== productName.toLowerCase()) brandsToReplace.push(t);
    }
  }
  const ogMatch = (originalHtml || '').match(/property=["']og:site_name["']\s*content=["']([^"']+)["']/i)
    || (originalHtml || '').match(/content=["']([^"']+)["']\s*property=["']og:site_name["']/i);
  if (ogMatch && ogMatch[1].trim().length > 3) brandsToReplace.push(ogMatch[1].trim());

  const productLower = productName.toLowerCase();
  const productTokensLower = new Set(productName.split(/\s+/).map((t) => t.toLowerCase()).filter(Boolean));
  const uniqueBrands = [...new Set(brandsToReplace.map((b) => b.trim()))]
    .filter((b) => b.length >= 5)
    .filter((b) => b.toLowerCase() !== productLower)
    .filter((b) => !productTokensLower.has(b.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (uniqueBrands.length === 0) return html;

  const protectedBlocks = [];
  let working = html.replace(/<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const idx = protectedBlocks.length; protectedBlocks.push(m); return `\u0000PROTECTED_BRAND_${idx}\u0000`;
  });
  const TLD_GUARD = `(?!\\.(?:com|org|net|io|co|us|uk|de|fr|es|it|me|info|ai|app|shop|store|biz|tv|live|xyz|pro|club|space|website))`;
  const htmlParts = working.split(/(<[^>]+>)/);
  for (let i = 0; i < htmlParts.length; i++) {
    if (!htmlParts[i].startsWith('<')) {
      for (const brand of uniqueBrands) {
        const escaped = escRxLiteral(brand);
        htmlParts[i] = htmlParts[i].replace(
          new RegExp(`(^|[^a-zA-Z0-9])${escaped}(?=[^a-zA-Z0-9]|$)${TLD_GUARD}`, 'gi'),
          (_m, prefix) => `${prefix}${productName}`,
        );
      }
    }
  }
  working = htmlParts.join('');
  working = working.replace(/\u0000PROTECTED_BRAND_(\d+)\u0000/g, (_m, idx) => protectedBlocks[Number(idx)] ?? '');
  return working;
}

// ──────────────────────────────────────────────────────────────────────
// absolutizeAssetUrls — risolvi gli URL relativi degli ASSET contro
// l'origin originale della pagina clonata.
//
// Perche' esiste:
//   Playwright cattura l'HTML renderizzato di una pagina sorgente, ma
//   ogni `<link href="/assets/index-ABCD.css">` / `<script src="/assets/
//   index-XYZ.js">` / `<img src="/img/hero.jpg">` / ecc. resta col path
//   RELATIVO. Quando l'HTML viene poi servito da un dominio diverso
//   (preview Wasabi, Supabase Storage, CheckoutChamp, Funnelish, dominio
//   custom del cliente), questi URL si risolvono contro il NUOVO dominio
//   → 404 → niente CSS, niente immagini, niente font → la pagina renderizza
//   senza stili = "tutta sconfusionata".
//
//   Tipico per:
//     - App Vite/CRA su Replit/Lovable (CSS Tailwind in /assets/*.css)
//     - Pagine Next.js SSR (CSS in /_next/static/css/*.css)
//     - Funnelish/ClickFunnels classic (immagini in /images/*, asset/*)
//
//   Soluzione: convertiamo gli URL relativi in ASSOLUTI puntando al
//   dominio sorgente. Il CSS / JS / immagini si caricano dal dominio
//   originale, e la pagina ha il suo aspetto corretto ovunque venga
//   servita.
//
// Cosa tocchiamo (asset, non navigazione):
//   - <link href=...>                        (stylesheet, preload, icon, ecc.)
//   - <script src=...>                       (bundle JS — se sopravvive allo strip)
//   - <img src=...>, <img srcset=...>        (immagini + responsive)
//   - <source src=...>, <source srcset=...>  (picture / video / audio)
//   - <video src=...>, <video poster=...>
//   - <audio src=...>
//   - <iframe src=...>
//   - <embed src=...>, <object data=...>
//   - <use href=...>                         (SVG sprite)
//   - meta og:image, twitter:image content (per i preview social)
//
// Cosa NON tocchiamo (navigation / utente naviga, non risolto):
//   - <a href=...>                           (link interni alla SPA originale
//                                            sarebbero rotti sul nuovo dominio;
//                                            li lasciamo cosi' come sono per non
//                                            mandare il visitatore al competitor)
//   - <form action=...>                      (idem, il submit deve restare locale)
//   - href dentro <use> per fragment puro (#...) → restano frammenti
//
// Regole di risoluzione:
//   - `data:`, `blob:`, `javascript:`, `mailto:`, `tel:`        → invariato
//   - `#fragment` (solo hash)                                    → invariato
//   - `http://...` o `https://...` (gia' assoluti)               → invariato
//   - `//cdn.x.com/foo` (protocol-relative)                      → `${proto}//cdn.x.com/foo`
//   - `/path/to/asset` (root-relative)                           → `${origin}/path/to/asset`
//   - `path/to/asset` (path-relative)                            → resolved via new URL()
function absolutizeAssetUrls(html, sourceUrl) {
  if (!html || typeof html !== 'string' || !sourceUrl) return html;
  let base;
  try {
    base = new URL(sourceUrl);
  } catch {
    return html;
  }
  const origin = base.origin;
  const proto = base.protocol;

  function resolve(value) {
    if (!value || typeof value !== 'string') return value;
    const v = value.trim();
    if (!v) return value;
    // Skip schemes non-HTTP e fragment puri.
    if (/^(?:data|blob|javascript|mailto|tel|sms|chrome|about|file):/i.test(v)) return value;
    if (v.startsWith('#')) return value;
    // Gia' assoluto.
    if (/^https?:\/\//i.test(v)) return value;
    // Protocol-relative: //cdn.x.com/foo
    if (v.startsWith('//')) return `${proto}${v}`;
    // Root-relative: /path/asset.css
    if (v.startsWith('/')) return `${origin}${v}`;
    // Path-relative (raro nelle pagine clonate via Playwright, ma capita).
    try {
      return new URL(v, base.href).toString();
    } catch {
      return value;
    }
  }

  function resolveSrcset(value) {
    if (!value || typeof value !== 'string') return value;
    // srcset = comma-separated list di "url descrittore" (es "img-2x.png 2x")
    // Risolvi solo la parte URL, mantieni il descrittore (1x/2x/100w/...).
    return value
      .split(',')
      .map((part) => {
        const s = part.trim();
        if (!s) return s;
        const m = s.match(/^(\S+)(\s+\S.*)?$/);
        if (!m) return s;
        return resolve(m[1]) + (m[2] || '');
      })
      .join(', ');
  }

  // Tag e attributi da assolutizzare. Niente <a> e niente <form>: vedi
  // commento d'apertura.
  // Ordine: tag → array di attributi-asset da risolvere come URL singola,
  //         + opzionale 'srcset' per quelli che usano lo srcset,
  //         + opzionale 'stripCors' per droppare crossorigin/integrity DOPO
  //           aver assolutizzato (fix CORS — vedi commento sotto).
  //
  // STRIP `crossorigin` su <link>/<script> assolutizzati:
  // Le pagine Vite/Replit emettono `<link rel="stylesheet" crossorigin
  // href="/assets/index-*.css">`. Quando il browser carica questo CSS
  // dal NUOVO dominio (es. Wasabi preview) la presenza di `crossorigin`
  // attiva il check CORS: il server sorgente (Replit) NON manda
  // `Access-Control-Allow-Origin` → il browser scarica il file ma
  // RIFIUTA di applicarne le regole CSS. Risultato: niente Tailwind,
  // pagina sconfusionata (= bug "tutta rotta uguale" 26 mag '26).
  // Dropping `crossorigin` riporta il caricamento al regime "no-cors"
  // standard: il browser scarica E applica il CSS, cross-origin
  // ammesso senza preflight. Strippiamo anche `integrity` (SRI)
  // perche' alcune combinazioni di SRI + drop-crossorigin generano
  // blocchi in Chrome.
  const tagAttrSpec = {
    link:   { single: ['href'],          srcset: false, stripCors: true  },
    script: { single: ['src'],           srcset: false, stripCors: true  },
    img:    { single: ['src', 'poster'], srcset: true,  stripCors: false },
    source: { single: ['src'],           srcset: true,  stripCors: false },
    video:  { single: ['src', 'poster'], srcset: false, stripCors: false },
    audio:  { single: ['src'],           srcset: false, stripCors: false },
    iframe: { single: ['src'],           srcset: false, stripCors: false },
    embed:  { single: ['src'],           srcset: false, stripCors: false },
    object: { single: ['data'],          srcset: false, stripCors: false },
    use:    { single: ['href', 'xlink:href'], srcset: false, stripCors: false },
    track:  { single: ['src'],           srcset: false, stripCors: false },
    meta:   { single: ['content'],       srcset: false, stripCors: false }, // og:image / twitter:image
  };

  let working = html;

  for (const [tagName, spec] of Object.entries(tagAttrSpec)) {
    // Match aperture del tag (anche self-closing): <tag ...> oppure <tag ... />
    // Case-insensitive. Catturiamo i soli attributi per riscriverli e
    // ricomporre il tag esattamente uguale (no normalizzazione).
    const tagRe = new RegExp(`<(${tagName})\\b([^>]*)>`, 'gi');
    working = working.replace(tagRe, (full, tag, attrs) => {
      // <meta content=...> va trattato solo per i metadata "asset-like"
      // (og:image, twitter:image, msapplication-TileImage). Senza questo
      // filtro assolutizzeremmo `<meta name="description" content="...">`
      // e simili che sono testi, non URL.
      if (tagName === 'meta') {
        const isAssetMeta =
          /(property|name)=["'](?:og:image|og:video|og:audio|twitter:image|twitter:player|msapplication-TileImage)["']/i.test(
            attrs,
          );
        if (!isAssetMeta) return full;
      }
      let newAttrs = attrs;
      let didAbsolutize = false;
      for (const attrName of spec.single) {
        const attrRe = new RegExp(`(\\s${attrName.replace(':', '\\:')}\\s*=\\s*)(["'])([^"']+)\\2`, 'gi');
        newAttrs = newAttrs.replace(attrRe, (_m, head, q, val) => {
          const resolved = resolve(val);
          if (resolved !== val) didAbsolutize = true;
          return `${head}${q}${resolved}${q}`;
        });
      }
      if (spec.srcset) {
        const srcsetRe = /(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi;
        newAttrs = newAttrs.replace(srcsetRe, (_m, head, q, val) => {
          const resolved = resolveSrcset(val);
          if (resolved !== val) didAbsolutize = true;
          return `${head}${q}${resolved}${q}`;
        });
      }
      // Strip crossorigin/integrity SOLO se abbiamo riscritto l'URL: cosi'
      // i CDN assoluti con crossorigin voluto (es. fonts.googleapis.com,
      // cdn.jsdelivr.net) mantengono il loro setting intatto.
      if (spec.stripCors && didAbsolutize) {
        newAttrs = newAttrs.replace(/\s+crossorigin(?:\s*=\s*(["'])[^"']*\1)?/gi, '');
        newAttrs = newAttrs.replace(/\s+integrity\s*=\s*(["'])[^"']*\1/gi, '');
      }
      return `<${tag}${newAttrs}>`;
    });
  }

  return working;
}

// Detect SPA: pagine costruite con Vue (data-v-*), React (data-reactroot,
// __NEXT_DATA__), Svelte (svelte-*), Nuxt (__NUXT__), o page builders che
// compilano a un componente (Funnelytics, ClickFunnels 2.0, Convertri,
// Shogun, Replo) si idratano dopo il render. Se il rewrite introduce nuovi
// tag (<p>, <strong>, <br>) che non c'erano nell'originale, il mismatch
// di hydration fa bail al framework e DISABILITA tutti gli event handler:
// accordion FAQ, slider, gallery, modali smettono di rispondere ai click
// pur continuando a renderizzare. Detection cheap su un sample 50KB.
function detectSpa(originalHtml) {
  if (!originalHtml || typeof originalHtml !== 'string') return false;
  const sample = originalHtml.substring(0, 50000);
  return (
    /\bdata-v-[a-f0-9]{6,}/.test(sample) ||
    /\bdata-reactroot\b/.test(sample) ||
    /__NEXT_DATA__/.test(sample) ||
    /__NUXT__/.test(sample) ||
    /__sveltekit_data/.test(sample) ||
    /\bsvelte-[a-z0-9]{6,}/.test(sample) ||
    /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/.test(sample) ||
    /<div[^>]+id=["']__next["'][^>]*>/.test(sample) ||
    /\bv-cloak\b/.test(sample) ||
    /\bng-(?:app|controller|view)\b/.test(sample)
  );
}

// Detect "modern SPA" = Vite/CRA/Lovable-style page dove TUTTO il rendering
// e l'interattivita' (state, routing, eventi) sono guidati da un bundle JS
// `<script type="module" src="/assets/index-*.js">`. Per queste pagine,
// l'applySpaPreviewMode standard (= stripOriginalScripts + inietta jQuery/
// Swiper fallback) e' CATASTROFICO: senza il bundle, React/Vue non
// montano mai, e i fallback jQuery/Swiper non c'entrano niente con il
// loro state-management. La pagina renderizza solo il DOM "fotografato"
// da Playwright al momento del clone, ma e' completamente inerte.
//
// Tipiche pagine che matchano:
//   - Replit React/Vite apps (es. fiber-muse-product-page.replit.app)
//   - Lovable apps (.lovable.app, .lovable.dev)
//   - StackBlitz / CodeSandbox preview
//   - Vercel/Netlify preview di Vite/CRA app (signature positiva)
//   - Qualsiasi build prod Vite con asset hash standard
//
// NON matchano (= mantengono il comportamento di strip esistente):
//   - Next.js SSR/ISR (script Next sono `/_next/static/chunks/...` NON
//     `type="module"`; il default Next non usa native ESM nel browser)
//   - Funnelish/ClickFunnels classic (jQuery + bundle non-module)
//   - Shopify Liquid SSR
//   - Vue/Funnelytics page builders compilati (data-v-* ma niente Vite signature)
//
// Detection a 4 livelli (qualunque dei 4 basta):
//   1. Vite production bundle signature: <script type="module" src="/assets/index-HASH.js">
//   2. Vite dev mode signature: <script type="module" src="/src/main.tsx|main.jsx|main.ts|main.js">
//   3. Hostname allowlist: *.replit.app/dev, *.lovable.app/dev, *.stackblitz.io, *.csb.app
//   4. "All scripts are modules" check: ogni <script src> ha type="module"
//      (e c'e' almeno 1 script) → e' un'app ES modules pure → moderna
function detectModernSpa(originalHtml, sourceUrl) {
  if (!originalHtml || typeof originalHtml !== 'string') {
    return { isModern: false, reason: 'no-html' };
  }
  const sample = originalHtml.substring(0, 100000);

  // 1. Vite production bundle: il path /assets/index-*.js con hash e'
  //    l'output Vite di default (vite build → dist/assets/index-[hash].js).
  //    Pattern molto specifico, falsi positivi quasi nulli.
  if (/<script\s+[^>]*type=["']module["'][^>]*src=["'][^"']*\/assets\/index-[a-zA-Z0-9_-]+\.js["']/i.test(sample)) {
    return { isModern: true, reason: 'vite-production-bundle' };
  }

  // 2. Vite dev mode: src=/src/main.* o /src/index.* (entry tipico).
  if (/<script\s+[^>]*type=["']module["'][^>]*src=["'][^"']*\/src\/(?:main|index)\.(?:tsx?|jsx?|mjs)["']/i.test(sample)) {
    return { isModern: true, reason: 'vite-dev-mode' };
  }

  // 3. Hostname allowlist: piattaforme che servono SOLO modern SPA stacks.
  //    Replit/Lovable sono target espliciti dell'utente; gli altri sono
  //    safety net per preview/staging deployment.
  if (sourceUrl && typeof sourceUrl === 'string') {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase();
      const modernHosts = [
        '.replit.app', '.replit.dev', '.repl.co',
        '.lovable.app', '.lovable.dev',
        '.stackblitz.io', '.stackblitz.com', '.webcontainer.io',
        '.csb.app', '.codesandbox.io',
      ];
      for (const suffix of modernHosts) {
        if (host.endsWith(suffix)) {
          return { isModern: true, reason: `hostname:${suffix}` };
        }
      }
    } catch { /* invalid URL, fall through */ }
  }

  // 4. "Tutti gli script con src sono type=module": ES modules pure app.
  //    Conta gli <script src=...> totali vs quelli type="module". Se >=1
  //    script e tutti sono module → moderna. Sicuro: classic jQuery /
  //    Funnelish / CheckoutChamp hanno SEMPRE almeno uno script non-module
  //    (jQuery CDN, swiper.min.js, custom inline, ecc.).
  const scriptsWithSrc = sample.match(/<script\b[^>]*\ssrc=["'][^"']+["'][^>]*>/gi) || [];
  if (scriptsWithSrc.length > 0) {
    const allModule = scriptsWithSrc.every((s) => /\stype=["']module["']/i.test(s));
    if (allModule) {
      return { isModern: true, reason: 'all-scripts-are-modules' };
    }
  }

  return { isModern: false, reason: 'no-modern-signature' };
}

// Rimuove tutti i tag HTML da un rewrite mantenendo solo il testo.
// Usato quando l'originale era plain text ma il LLM ha aggiunto markup
// (problema tipico su SPA: rompe l'hydration).
function stripAllHtmlTags(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// SPA safety: garantisce che il rewrite NON cambi la struttura dei tag
// rispetto all'originale.
//   - originale plain + rewrite con tag → strip tag dal rewrite
//   - originale con tag + rewrite con tag → fallback a plain (non riusciamo
//     a riallineare i tag, meglio perdere formattazione che rompere hydration)
//   - originale con tag + rewrite plain → ok, distributeTextProportionally
//     ridistribuira' il testo sui segmenti preservando i tag originali
function enforceSpaSafety(originalText, rewrittenText) {
  const originalHasTags = /<[a-zA-Z\/]/.test(originalText || '');
  const rewrittenHasTags = /<[a-zA-Z\/]/.test(rewrittenText || '');
  if (!rewrittenHasTags) return rewrittenText;
  // rewritten ha tag → strip in entrambi i casi (sia se originalHasTags
  // sia se non li aveva; nel primo caso preserveremo i tag originali via
  // distributeTextProportionally durante il fuzzy replace).
  return stripAllHtmlTags(rewrittenText);
}

// Collassa run consecutive del product name ("Reset Patch Reset Patch" →
// "Reset Patch") dentro lo stesso text-node. Mai cross-tag (rompe handler).
function collapseConsecutiveBrandRuns(html, productName) {
  if (!productName || productName.length < 3) return html;
  const escaped = escRxLiteral(productName);
  const gap = `(?:[\\s\\u00A0]|&nbsp;|&\\#160;|[\\-–—:|·•†*])*`;
  const dup = new RegExp(`(${escaped})${gap}\\1`, 'gi');
  const protectedBlocks = [];
  let working = html.replace(/<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const idx = protectedBlocks.length; protectedBlocks.push(m); return `\u0000PROTECTED_COLLAPSE_${idx}\u0000`;
  });
  const segments = working.split(/(<[^>]+>)/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg.startsWith('<')) continue;
    let prev = seg;
    for (let pass = 0; pass < 6; pass++) {
      const next = prev.replace(dup, '$1');
      if (next === prev) break;
      prev = next;
    }
    segments[i] = prev;
  }
  working = segments.join('');
  working = working.replace(/\u0000PROTECTED_COLLAPSE_(\d+)\u0000/g, (_m, idx) => protectedBlocks[Number(idx)] ?? '');
  return working;
}

// Strip <script>, <noscript> e attributi inline on* dall'HTML. Mantiene
// gli script che hanno l'attributo data-fallback (i nostri injection).
// Usato in spa-preview-mode per evitare che il bundle Vue/Funnelish/
// CheckoutChamp originale tenti di montare contro un dominio che non e'
// il suo (manca sessione, API, ecc.) lasciando i bottoni inerti.
function stripOriginalScripts(html) {
  let out = html;
  const before = (out.match(/<script\b/gi) || []).length;
  out = out.replace(/<script\b(?![^>]*data-fallback=)(?![^>]*data-inlined-bundle=)[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b(?![^>]*data-fallback=)(?![^>]*data-inlined-bundle=)[^>]*\/>/gi, '');
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  out = out.replace(/\s+on[a-z]+="[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+='[^']*'/gi, '');
  const after = (out.match(/<script\b/gi) || []).length;
  return { html: out, scriptsBefore: before, scriptsAfter: after };
}

// Fix navigation Next.js: i quiz Next.js fanno fetch a
// /_next/data/<buildId>/<page>.json per props della pagina successiva.
// Su un dominio clonato questi danno 404 → quiz si blocca al primo click.
// Monkey-patch del fetch per ritornare pageProps:{} (lo state del
// componente quiz mantiene comunque la domanda corrente).
const NEXTJS_NAVIGATION_FIX = `<script data-fallback="navigation-fix">(function(){
  if (typeof window === 'undefined') return;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;
  window.fetch = function(input, init){
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\\/_next\\/data\\//.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({pageProps:{},__N_SSP:true}),{status:200,headers:{'Content-Type':'application/json'}}));
      }
    } catch(e){}
    return origFetch(input, init);
  };
})();</script>`;

// CSS hard-override per FAQ/accordion. Strategia pragmatica: tutte le FAQ
// visibili DI DEFAULT (no JS necessario per leggerle). Il toggle JS
// nostro aggiunge/rimuove .fb-collapsed per richiuderle. Specificity alta
// per battere Vue scoped CSS [data-v-*].
const FAQ_CSS_OVERRIDE = `<style data-fallback="faq-css">
html body .faq .faq-content-wrapper,html body .faq .faq-content,html body .faq-wrapper .faq-content-wrapper,html body .faq-wrapper .faq-content,html body .faq-item .faq-body,html body .faq-item .faq-answer,html body .accordion-item .accordion-content,html body .accordion-item .accordion-body,html body .accordion-item .accordion-collapse,html body details > *:not(summary){display:block !important;max-height:none !important;height:auto !important;min-height:0 !important;overflow:visible !important;visibility:visible !important;opacity:1 !important;transform:none !important;pointer-events:auto !important;}
html body .faq.fb-collapsed .faq-content-wrapper,html body .faq.fb-collapsed .faq-content,html body .faq-wrapper.fb-collapsed .faq-content-wrapper,html body .faq-wrapper.fb-collapsed .faq-content,html body .faq-item.fb-collapsed .faq-body,html body .faq-item.fb-collapsed .faq-answer,html body .accordion-item.fb-collapsed .accordion-content,html body .accordion-item.fb-collapsed .accordion-body{display:none !important;}
.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,.accordion-question,.accordion-toggle,summary{cursor:pointer !important;}
.fb-icon-rotated{transform:rotate(180deg) !important;transition:transform .2s !important;}
html body .stickSection{display:block !important;visibility:visible !important;opacity:1 !important;}
</style>`;

// LAYOUT OVERFLOW FIX: il testo riscritto dall'AI è quasi sempre piu' lungo
// dell'originale. I template Tailwind/Vite (Replit & co.) usano spesso
// altezze fisse arbitrarie tipo md:h-[323px], min-h-[400px], aspect-[a/b],
// dimensionate sulla LUNGHEZZA del testo originale. Quando il testo cresce,
// va in overflow e si sovrappone alle sezioni vicine (cards che si
// pestano, headings sopra paragrafi, CTA mangiate, ecc.).
//
// Strategia: rilassiamo i constraint di altezza SOLO sui contenitori che
// contengono effettivamente testo (heading/paragraph/list/blockquote),
// usando il selettore :has(). Img/svg/video/canvas non hanno discendenti
// di questo tipo quindi non vengono toccati: la photo gallery, gli sliders
// e gli iframe restano intatti. Specificity alta (html body …) per
// battere Tailwind utilities con specificity bassa.
const LAYOUT_OVERFLOW_FIX = `<style data-fallback="layout-overflow-fix">
@supports selector(:has(*)) {
html body [class*="h-["]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [class*="min-h-["]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [class*="max-h-["]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [class*="aspect-["]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [style*="height:"]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [style*="max-height:"]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl),
html body [style*="aspect-ratio:"]:has(p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl){
  height:auto !important;min-height:0 !important;max-height:none !important;
  aspect-ratio:auto !important;overflow:visible !important;
}
}
html body [class*="overflow-hidden"]:has(>h1,>h2,>h3,>h4,>h5,>h6,>p,>ul,>ol,>blockquote){overflow:visible !important;}
html body [class*="line-clamp-"],html body [class*="truncate"]{-webkit-line-clamp:unset !important;line-clamp:unset !important;display:block !important;overflow:visible !important;text-overflow:clip !important;white-space:normal !important;}
</style>`;

// Fallback init server-side: jQuery + Swiper da CDN se mancano, FAQ
// accordion delegato, thumb→main image binding, sticky CTA visibili.
// Idempotente: window.__FB_FALLBACK_INSTALLED segna l'installazione.
const FALLBACK_INIT_SCRIPT = `<script data-fallback="init">(function(){
  var FB_VERSION='worker-finalize-v1';
  if(window.__FB_FALLBACK_INSTALLED){return;} window.__FB_FALLBACK_INSTALLED=FB_VERSION;
  function loadCss(href){if(document.querySelector('link[data-fb-css="'+href+'"]'))return;var l=document.createElement('link');l.rel='stylesheet';l.href=href;l.dataset.fbCss=href;document.head.appendChild(l);}
  function loadScript(src,cb){var existing=document.querySelector('script[data-fb-src="'+src+'"]');if(existing){if(existing.__loaded){cb();}else{existing.addEventListener('load',cb);existing.addEventListener('error',cb);}return;}var s=document.createElement('script');s.src=src;s.async=false;s.dataset.fbSrc=src;s.addEventListener('load',function(){s.__loaded=true;cb();});s.addEventListener('error',function(){cb();});(document.head||document.documentElement).appendChild(s);}
  function findContents(header){var p=header.closest('.faq,.faq-wrapper,.faq-item,.accordion-item,details')||header.parentElement;return p;}
  function toggleFaq(header){var p=findContents(header);if(!p)return;var willCollapse=!p.classList.contains('fb-collapsed');if(willCollapse){p.classList.add('fb-collapsed');p.classList.remove('active','open','expanded','is-open','show');if(p.tagName==='DETAILS')p.removeAttribute('open');}else{p.classList.remove('fb-collapsed');p.classList.add('active','open','expanded','is-open','show');if(p.tagName==='DETAILS')p.setAttribute('open','');}header.setAttribute('aria-expanded',willCollapse?'false':'true');var icon=header.querySelector('.faq-icon,.accordion-icon,svg');if(icon){if(willCollapse)icon.classList.remove('fb-icon-rotated');else icon.classList.add('fb-icon-rotated');}}
  function bindFaq(){if(document.body.__faqDelegateBound)return;document.body.__faqDelegateBound=true;document.body.addEventListener('click',function(ev){var t=ev.target;if(!t||!t.closest)return;var actionable=t.closest('a,button,input,select,textarea,label,[role="button"],[onclick]');var header=t.closest('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-question,.accordion-toggle,.accordion-button,[data-faq-toggle],[data-toggle="collapse"],summary');if(!header)return;if(actionable&&header.contains(actionable)&&actionable!==header)return;ev.preventDefault();ev.stopPropagation();try{toggleFaq(header);}catch(e){}},true);document.querySelectorAll('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,summary').forEach(function(h){h.style.cursor='pointer';});}
  function bindThumbs(){if(document.body.__thumbDelegateBound)return;document.body.__thumbDelegateBound=true;document.body.addEventListener('click',function(ev){var t=ev.target;if(!t||!t.closest)return;var tc=t.closest('.thumbImage,.swiper-thumbs,[data-thumb-container]');if(!tc)return;var ti=t.closest('.swiper-slide,[data-thumb],img');if(!ti)return;var sib=Array.prototype.slice.call(tc.querySelectorAll('.swiper-slide,[data-thumb]'));if(!sib.length)sib=Array.prototype.slice.call(tc.querySelectorAll('img'));var idx=sib.indexOf(ti);if(idx<0){var p=ti;while(p&&idx<0){idx=sib.indexOf(p);p=p.parentElement;}}var mainEl=document.querySelector('.swiper.mainImage');if(mainEl&&mainEl.swiper&&idx>=0){try{mainEl.swiper.slideTo(idx);}catch(_){}}var img=ti.tagName==='IMG'?ti:ti.querySelector('img');if(img){var src=img.currentSrc||img.src||img.getAttribute('data-src');if(src){var m=document.querySelector('.swiper.mainImage .swiper-slide-active img,.swiper.mainImage .swiper-slide img,.mainImage img:not(.thumb),.product-image img');if(m){m.src=src;m.removeAttribute('srcset');}}}},true);}
  function initSwipers(){if(typeof window.Swiper!=='function')return false;var thumbs=[];document.querySelectorAll('.swiper.thumbImage,.swiper.swiper-thumbs').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;try{thumbs.push(new window.Swiper(el,{slidesPerView:'auto',spaceBetween:10,watchSlidesProgress:true,freeMode:true,slideToClickedSlide:true}));}catch(_){}});document.querySelectorAll('.swiper.mainImage').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;var opts={slidesPerView:1,spaceBetween:10,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}};if(thumbs[0])opts.thumbs={swiper:thumbs[0]};try{new window.Swiper(el,opts);}catch(_){}});document.querySelectorAll('.swiper').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;var ann=el.classList.contains('announcement_bar');try{new window.Swiper(el,{slidesPerView:1,spaceBetween:10,loop:ann,autoplay:ann?{delay:3500}:false,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}});}catch(_){}});document.querySelectorAll('.stickSection').forEach(function(s){s.style.display='';});return true;}
  // LAYOUT OVERFLOW FIX (JS fallback): se il browser non supporta :has(),
  // o se i replacement runtime hanno gonfiato il testo dopo il primo render,
  // rilassiamo imperativamente le altezze fisse sui contenitori che hanno
  // discendenti testuali. Selettore selettivo: solo classi/style con
  // arbitrary-height tailwind o inline; salta sempre img/video/svg/canvas/iframe.
  function relaxFixedHeights(){try{
    var sel='[class*="h-["],[class*="min-h-["],[class*="max-h-["],[class*="aspect-["],[style*="height:"],[style*="max-height:"],[style*="aspect-ratio:"]';
    var nodes=document.querySelectorAll(sel);
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i];
      var tn=el.tagName;
      if(tn==='IMG'||tn==='VIDEO'||tn==='SVG'||tn==='svg'||tn==='CANVAS'||tn==='IFRAME'||tn==='PICTURE')continue;
      if(!el.querySelector('p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,dl'))continue;
      if(el.__fbRelaxed)continue; el.__fbRelaxed=1;
      el.style.setProperty('height','auto','important');
      el.style.setProperty('min-height','0','important');
      el.style.setProperty('max-height','none','important');
      el.style.setProperty('aspect-ratio','auto','important');
      el.style.setProperty('overflow','visible','important');
    }
    var clamps=document.querySelectorAll('[class*="line-clamp-"],.truncate,[class*="truncate"]');
    for(var j=0;j<clamps.length;j++){
      var c=clamps[j];
      c.style.setProperty('-webkit-line-clamp','unset','important');
      c.style.setProperty('line-clamp','unset','important');
      c.style.setProperty('display','block','important');
      c.style.setProperty('overflow','visible','important');
      c.style.setProperty('text-overflow','clip','important');
      c.style.setProperty('white-space','normal','important');
    }
  }catch(_){}}
  function watchRelax(){try{
    if(window.__fbRelaxObs)return;
    relaxFixedHeights();
    var pending=null;
    function schedule(){if(pending)return;pending=(window.requestAnimationFrame||function(cb){return setTimeout(cb,16);})(function(){pending=null;relaxFixedHeights();});}
    var mo=new MutationObserver(schedule);
    mo.observe(document.body||document.documentElement,{childList:true,subtree:true,characterData:true});
    window.__fbRelaxObs=mo;
    setTimeout(relaxFixedHeights,500);setTimeout(relaxFixedHeights,2000);setTimeout(relaxFixedHeights,5000);
  }catch(_){}}
  function bootstrap(){bindFaq();bindThumbs();watchRelax();var hasJq=typeof window.jQuery!=='undefined';var hasSw=typeof window.Swiper==='function';loadCss('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css');var pending=0;function done(){if(--pending<=0)finalize();}if(!hasJq){pending++;loadScript('https://code.jquery.com/jquery-3.5.1.min.js',done);}if(!hasSw){pending++;loadScript('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',done);}if(pending===0)finalize();}
  function finalize(){initSwipers();bindFaq();bindThumbs();relaxFixedHeights();setTimeout(function(){initSwipers();relaxFixedHeights();},1500);}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',bootstrap);}else{setTimeout(bootstrap,50);}
})();</script>`;

function finalizeSwipe({ html, sourceUrl, texts, rewrites, productName, applySpaPreviewMode }) {
  const t0 = Date.now();
  if (!html || typeof html !== 'string' || html.length < 50) {
    throw new Error('html is required');
  }
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts[] is required');
  if (!Array.isArray(rewrites)) throw new Error('rewrites[] is required');

  // ASSOLUTIZZAZIONE asset URL (PRIMA cosa che facciamo sull'HTML grezzo).
  //
  // Playwright cattura `<link href="/assets/index-ABCD.css">` e simili con
  // il path RELATIVO al dominio sorgente. Se serviamo questo HTML da un
  // dominio diverso (Wasabi preview, Supabase Storage, hosting cliente),
  // il path /assets/... colpisce il NUOVO origin → 404 → CSS non caricato
  // → "pagina tutta sconfusionata" (Tailwind sparito, layout collassato).
  //
  // Fix: riscriviamo TUTTI gli URL relativi degli ASSET (CSS/JS/img/font/
  // video/iframe/og:image…) puntandoli all'origin originale. La navigation
  // (<a>, <form>) resta intatta per non re-indirizzare l'utente al
  // competitor. Le `texts[]` arrivano dal worker DOPO la sostituzione
  // pari pari, quindi non vengono toccate da questo passaggio (gli URL
  // non rientrano nei texts estratti).
  const originalHtml = sourceUrl ? absolutizeAssetUrls(html, sourceUrl) : html;
  const isSpa = detectSpa(originalHtml);

  // id → rewritten map. Quando la pagina e' SPA applichiamo SPA-safety:
  // ogni rewrite che ha aggiunto tag non presenti nell'originale viene
  // strippato a plain text, altrimenti l'hydration di Vue/React/Svelte
  // fa bail e disabilita tutti i click handler (accordion, slider, ecc.).
  const idToRewrite = new Map();
  const textById = new Map();
  let spaSafetyStrips = 0;
  for (const t of texts) textById.set(t.id, t);
  for (const rw of rewrites) {
    if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
    const trimmed = rw.rewritten.trim();
    if (!trimmed) continue;
    const original = textById.get(rw.id);
    const originalText = original?.original;
    if (originalText && trimmed === originalText) continue;
    let safeText = trimmed;
    if (isSpa) {
      const before = safeText;
      safeText = enforceSpaSafety(originalText || '', safeText);
      if (safeText !== before) spaSafetyStrips++;
      if (!safeText) continue;
    }
    idToRewrite.set(rw.id, safeText);
  }
  const unresolvedIds = texts.filter((t) => !idToRewrite.has(t.id)).map((t) => t.id);

  const replacementPairs = [];
  const serverSideTitlePairs = [];
  const serverSideMetaPairs = [];
  // Live-chat comment rewrites (tag 'comment') go into the TIMED array
  // server-side — the DOM replacer skips <script>. Keyed by original text so
  // any resolved id matching a comment updates the array.
  const commentRewrites = new Map();
  for (const [id, rewritten] of idToRewrite) {
    const original = textById.get(id);
    if (!original || !rewritten || original.original === rewritten) continue;
    commentRewrites.set(original.original, rewritten);
    if (original.tag === 'comment') continue;
    if (original.tag === 'title') {
      serverSideTitlePairs.push({ from: original.original, to: rewritten });
      replacementPairs.push({ from: original.original, to: rewritten });
    } else if (original.tag === 'attr:meta-content') {
      serverSideMetaPairs.push({ from: original.original, to: rewritten });
    } else if (original.tag.startsWith('attr:')) {
      replacementPairs.push({
        from: original.original,
        to: rewritten,
        attr: original.tag.replace('attr:', ''),
      });
    } else {
      replacementPairs.push({ from: original.original, to: rewritten });
    }
  }

  // swipeScript (SPA-aware con MutationObserver + polling).
  //
  // ⚠️ JSON-in-<script> escaping: `replacementPairs` puo' contenere
  // qualsiasi stringa estratta dalla pagina del competitor o emessa dal
  // LLM. Se uno dei valori contiene la sottostringa "</script>" (es.
  // un advertorial che cita codice, un FAQ "come modifico lo script
  // della checkout", o anche solo il pattern dentro un commento HTML),
  // `JSON.stringify` la emette letterale: il parser HTML vede
  // </script> e CHIUDE il tag in mezzo al codice JS. Risultato visibile
  // nel browser: tutta la coda dello script (function normWS, pairs,
  // clearInterval, ecc.) appare come TESTO nel <body>, e i swipe
  // replacement runtime non partono mai. Fix standard: escapare le
  // sequenze che possono uscire dal contesto <script>:
  //   • </script  →  <\/script    (script-tag breakout)
  //   • </style   →  <\/style     (se mai usato dentro <style>)
  //   • <!--      →  <\!--        (HTML comment dentro script)
  //   • U+2028 / U+2029           (line separators: validi in JSON ma
  //                                NON in JS literal → SyntaxError)
  const pairsJson = JSON.stringify(replacementPairs)
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${pairsJson};
  function escRx(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  function normWS(s){return (s||'').replace(/\\s+/g,' ').trim();}
  var prepared = pairs.map(function(p){
    var fn = normWS(p.from);
    return { from: p.from, to: p.to, attr: p.attr, norm: fn,
      rx: fn ? new RegExp(escRx(fn).replace(/ /g,'\\\\s+'),'g') : null };
  }).filter(function(p){return p.norm && p.norm.length>=2;});
  function tryReplace(text){
    if(!text) return text;
    var out = text;
    for(var i=0;i<prepared.length;i++){
      var p = prepared[i];
      if(p.attr) continue;
      if(out.indexOf(p.from)!==-1){ out = out.split(p.from).join(p.to); }
      else if(p.rx && p.rx.test(out)){ p.rx.lastIndex=0; out = out.replace(p.rx, p.to); }
    }
    return out;
  }
  function applyAll(root){
    if(!root) return 0;
    var changed = 0;
    var blockSel = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,button,a,label,figcaption,blockquote,summary,legend,span,strong,em,b,i';
    var elems = root.querySelectorAll ? root.querySelectorAll(blockSel) : [];
    for(var k=0;k<elems.length;k++){
      var el = elems[k];
      if(el.querySelector && el.querySelector(blockSel)) continue;
      var fullNorm = normWS(el.textContent);
      if(!fullNorm) continue;
      for(var p2=0;p2<prepared.length;p2++){
        var pp = prepared[p2];
        if(pp.attr) continue;
        if(fullNorm === pp.norm && el.textContent !== pp.to){
          el.textContent = pp.to; changed++; break;
        }
      }
    }
    function walkText(node){
      if(node.nodeType===3){
        var t = node.textContent; var nt = tryReplace(t);
        if(nt !== t){ node.textContent = nt; changed++; }
      } else if(node.nodeType===1 && node.tagName!=='SCRIPT' && node.tagName!=='STYLE'){
        for(var c=node.firstChild;c;c=c.nextSibling) walkText(c);
      }
    }
    if(root.nodeType) walkText(root);
    for(var a=0;a<prepared.length;a++){
      var pa = prepared[a];
      if(!pa.attr) continue;
      var els = root.querySelectorAll ? root.querySelectorAll('['+pa.attr+']') : [];
      for(var j=0;j<els.length;j++){
        var v = els[j].getAttribute(pa.attr); if(!v) continue;
        var nv = v;
        if(v.indexOf(pa.from)!==-1){ nv = v.split(pa.from).join(pa.to); }
        else if(pa.rx && pa.rx.test(v)){ pa.rx.lastIndex=0; nv = v.replace(pa.rx, pa.to); }
        if(nv !== v){ els[j].setAttribute(pa.attr, nv); changed++; }
      }
    }
    var titleEl = document.querySelector('title');
    if(titleEl){
      var tt = titleEl.textContent; var ntt = tryReplace(tt);
      if(ntt !== tt){ titleEl.textContent = ntt; changed++; }
    }
    return changed;
  }
  applyAll(document);
  if(document.readyState !== 'loading'){ setTimeout(function(){ applyAll(document); }, 0); }
  else { document.addEventListener('DOMContentLoaded', function(){ applyAll(document); }); }
  if(typeof MutationObserver !== 'undefined'){
    var pendingApply = null;
    var observer = new MutationObserver(function(){
      if(pendingApply) return;
      pendingApply = setTimeout(function(){ pendingApply = null; applyAll(document); }, 100);
    });
    if(document.body){
      observer.observe(document.body, { childList:true, subtree:true, characterData:true });
    } else {
      document.addEventListener('DOMContentLoaded', function(){
        if(document.body) observer.observe(document.body, { childList:true, subtree:true, characterData:true });
      });
    }
    setTimeout(function(){ try { observer.disconnect(); } catch(e){} }, 30000);
  }
  var pollCount = 0;
  var pollTimer = setInterval(function(){
    pollCount++; applyAll(document);
    if(pollCount >= 20) clearInterval(pollTimer);
  }, 500);
})();
<\/script>`;

  // Server-side replace title + meta
  let preparedHtml = originalHtml;
  for (const tp of serverSideTitlePairs) {
    const rx = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(escHtml(tp.from))}\\s*(<\\/title>)`, 'gi');
    const before = preparedHtml;
    preparedHtml = preparedHtml.replace(rx, `$1${escHtml(tp.to)}$2`);
    if (preparedHtml === before) {
      const rxRaw = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(tp.from)}\\s*(<\\/title>)`, 'gi');
      preparedHtml = preparedHtml.replace(rxRaw, `$1${escHtml(tp.to)}$2`);
    }
  }
  // SAFE-META WHITELIST: il server-side meta replace deve toccare SOLO i
  // meta che sono "marketing copy" (description, keywords, og:*, twitter:*,
  // article:*). MAI viewport/charset/robots/theme-color/format-detection/
  // ecc. perche' sono valori tecnici che cambiano la resa della pagina
  // (es. viewport rotto → layout mobile collassa).
  //
  // Il filtro a monte (text-extractor META_TECHNICAL_KEYS) gia' impedisce
  // che il viewport entri nel pool LLM, ma:
  //   1. il LLM puo' allucinare e produrre rewrite per testi che non
  //      gli abbiamo chiesto (es. ha visto il viewport nell'HTML del
  //      contesto e ha "risposto" con un messaggio italiano);
  //   2. una mapping {from:"X", to:"Aspetta credo ci sia un malinteso..."}
  //      con regex `content="X"` puo' colpire un meta tecnico per
  //      coincidenza.
  // Filtro hard difensivo qui = ultima linea di difesa.
  const SAFE_META_NAMES = new Set([
    'description', 'keywords', 'author', 'subject', 'abstract', 'summary',
    // OpenGraph (marketing copy)
    'og:title', 'og:description', 'og:site_name', 'og:type',
    'og:locale', 'og:alternate_locale',
    // Twitter card (marketing copy)
    'twitter:title', 'twitter:description', 'twitter:card', 'twitter:creator',
    'twitter:site',
    // Article meta (blog/landing)
    'article:author', 'article:section', 'article:tag',
    // Itemprop (Schema.org embedded nei meta)
    'itemprop:name', 'itemprop:description',
  ]);
  function isSafeMetaTag(metaTagStr) {
    const nameM = metaTagStr.match(/\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i);
    if (!nameM) return false; // niente name → meta strutturale (charset, http-equiv)
    return SAFE_META_NAMES.has(nameM[1].toLowerCase());
  }
  for (const mp of serverSideMetaPairs) {
    const replaceMetaContent = (htmlStr, fromValue, toValue) => {
      // Match TUTTO il tag <meta ...> per poter ispezionare attrs prima
      // di decidere se sostituire (whitelist sopra).
      const tagRe = new RegExp(
        `<meta\\b([^>]*?)\\bcontent\\s*=\\s*(["'])${escRxLiteral(fromValue)}\\2([^>]*)>`,
        'gi',
      );
      return htmlStr.replace(tagRe, (full, attrsBefore, q, attrsAfter) => {
        if (!isSafeMetaTag(full)) return full; // viewport/charset/ecc. → intatto
        // Callback form: niente interpretazione di $& nel toValue.
        return `<meta${attrsBefore}content=${q}${escAttr(toValue)}${q}${attrsAfter}>`;
      });
    };
    preparedHtml = replaceMetaContent(preparedHtml, escAttr(mp.from), mp.to);
    if (mp.from !== escAttr(mp.from)) {
      preparedHtml = replaceMetaContent(preparedHtml, mp.from, mp.to);
    }
  }

  // Server-side DOM text replace (per SPA che re-idratano).
  // Strategia a cascata per ogni pair, ordinate per length desc così i testi
  // lunghi vincono sui figli inline e non c'è doppia sostituzione parziale:
  //   1) HTML-encoded literal (testo cosi' com'e' nell'HTML serializzato)
  //   2) raw literal (se differisce dall'encoded)
  //   3) JSON-encoded literal (es. dentro __NEXT_DATA__ / spa-json)
  //   4) FUZZY tag-tolerant + distributeTextProportionally
  //      (per testo spezzato tra <strong>, <em>, <span>, <br>, &nbsp; ecc.)
  const dedupedDomPairs = replacementPairs
    .filter((p) => !p.attr && p.from && p.to && p.from !== p.to)
    .sort((a, b) => b.from.length - a.from.length);
  let serverReplacementsCount = 0;
  let fuzzyReplacementsCount = 0;
  const unmatchedAfterServer = [];
  // BUG FIX (review-95 Nooro): l'ordine length-desc del sort sopra e' giusto
  // ma il flow originale faceva PRIMA TUTTI i literal split di TUTTI i pair,
  // POI tutti i fuzzy. Effetto disastroso: un pair lungo "Nooro NMES Foot
  // Massager uses the power of NeuroMuscular Electrical..." con tag annidati
  // (a<a>...</a></b> uses the power of <b>...</b>) falliva il literal
  // (plain-text non matcha HTML con tag inline) e finiva in
  // unmatchedAfterServer. INTANTO i pair corti "Nooro NMES Foot Massager",
  // "NeuroMuscular Electrical..." venivano applicati come literal SUCCESSO,
  // distruggendo le keyword del pair lungo. Quando poi il fuzzy del pair
  // lungo girava, le sue parole-chiave non erano piu' nell'HTML → fallimento.
  // Risultato: porzioni di copy fra i pezzi corti restavano in lingua
  // originale (es. "to correct overpronation and relieve associated pain").
  // FIX: per ogni pair, prova LITERAL → se fallisce, prova FUZZY SUBITO,
  // PRIMA di passare al pair successivo. Cosi' il pair lungo (che viene
  // prima per il sort length-desc) ha la chance di matchare via fuzzy
  // mentre l'HTML contiene ancora le sue keyword originali.
  for (const pair of dedupedDomPairs) {
    if (pair.from.length < 3) continue;
    const fromEsc = escHtml(pair.from);
    const toEsc = escHtml(pair.to);
    let appliedThisPair = false;
    {
      const before = preparedHtml;
      preparedHtml = preparedHtml.split(fromEsc).join(toEsc);
      if (preparedHtml !== before) { serverReplacementsCount++; appliedThisPair = true; }
    }
    if (pair.from !== fromEsc) {
      const beforeRaw = preparedHtml;
      preparedHtml = preparedHtml.split(pair.from).join(pair.to);
      if (preparedHtml !== beforeRaw) { serverReplacementsCount++; appliedThisPair = true; }
    }
    const fromJson = JSON.stringify(pair.from).slice(1, -1);
    const toJson = JSON.stringify(pair.to).slice(1, -1);
    if (fromJson !== pair.from && fromJson !== fromEsc) {
      const beforeJson = preparedHtml;
      preparedHtml = preparedHtml.split(fromJson).join(toJson);
      if (preparedHtml !== beforeJson) { serverReplacementsCount++; appliedThisPair = true; }
    }
    // ── FUZZY IMMEDIATO se literal non ha matchato ────────────────────
    // Tentativo tag-tolerant con il from raw e con la versione escHtml.
    // Se fuzzy matcha, l'HTML del pair lungo viene sostituito PRIMA che
    // un pair corto successivo possa distruggere il suo originale.
    if (!appliedThisPair) {
      const fuz1 = fuzzyReplaceWithTagPreservation(preparedHtml, pair.from, pair.to);
      if (fuz1.replaced) {
        preparedHtml = fuz1.html;
        fuzzyReplacementsCount++;
        appliedThisPair = true;
      } else if (fromEsc !== pair.from) {
        const fuz2 = fuzzyReplaceWithTagPreservation(preparedHtml, fromEsc, escHtml(pair.to));
        if (fuz2.replaced) {
          preparedHtml = fuz2.html;
          fuzzyReplacementsCount++;
          appliedThisPair = true;
        }
      }
    }
    if (!appliedThisPair) unmatchedAfterServer.push(pair);
  }

  // Attributi
  for (const pair of replacementPairs) {
    if (!pair.attr || !pair.from || !pair.to || pair.from === pair.to) continue;
    const fromAttrEsc = escAttr(pair.from);
    const toAttrEsc = escAttr(pair.to);
    const rxDQ = new RegExp(`(\\b${escRxLiteral(pair.attr)}=)"${escRxLiteral(fromAttrEsc)}"`, 'gi');
    const rxSQ = new RegExp(`(\\b${escRxLiteral(pair.attr)}=)'${escRxLiteral(fromAttrEsc)}'`, 'gi');
    const before = preparedHtml;
    preparedHtml = preparedHtml.replace(rxDQ, `$1"${toAttrEsc}"`);
    preparedHtml = preparedHtml.replace(rxSQ, `$1'${toAttrEsc}'`);
    if (preparedHtml !== before) serverReplacementsCount++;
  }

  // Pulizia finale prima del swipeScript:
  //   - Liquid/Jinja placeholders ({{MMMM dd, yyyy}}, {{Location}}…) → valori reali
  //   - brand replace dal dominio (es. "nooro" → productName) con TLD guard
  //   - collapse consecutive brand runs ("Reset Patch Reset Patch" → "Reset Patch")
  preparedHtml = replaceLiquidPlaceholders(preparedHtml);
  if (productName && typeof productName === 'string' && productName.trim().length >= 3) {
    preparedHtml = replaceBrandInHtml(preparedHtml, sourceUrl, originalHtml, productName.trim());
    preparedHtml = collapseConsecutiveBrandRuns(preparedHtml, productName.trim());
  }

  // SPA preview mode (opt-in, default = auto-on per pagine SPA).
  // Strippa <script>, <noscript>, on* handlers originali e inietta:
  //   - fix navigation Next.js (/_next/data/* → 200 vuoto)
  //   - CSS hard-override FAQ/accordion (sempre visibili)
  //   - fallback init (FAQ delegate, thumb→main image, Swiper da CDN)
  // Cosi' il preview e' interattivo anche quando il bundle originale
  // tenta di montare su un dominio che non e' il suo e fallisce.
  //
  // Nota — Modern SPA (Vite/CRA/Lovable/Replit):
  // In passato avevamo provato a PRESERVARE il bundle module per queste
  // pagine, ma il risultato era una pagina con layout rotto: anche con il
  // bundle preservato, gli URL relativi degli asset (CSS/JS) puntavano al
  // dominio sbagliato e Tailwind non caricava → "tutta sconfusionata"
  // (vedi commit 0ec7064 → revert). Oggi la strategia e' diversa:
  //   1. ASSOLUTIZZIAMO TUTTI gli URL degli asset all'inizio
  //      (absolutizeAssetUrls sopra) → il CSS Tailwind carica dall'origin
  //      sorgente → layout integro.
  //   2. STRIPPIAMO comunque gli script anche sui modern SPA → pagina
  //      statica ma visualmente identica all'originale.
  //   3. I rewrite testuali entrano via server-side replace + swipeScript
  //      → la pagina e' un "fotogramma" rewritten dell'originale,
  //      predicibile e privo di hydration mismatch React.
  // detectModernSpa funge sia da telemetria sia da fallback per detectSpa
  // — la regex SPA classica cerca markers come `<div id="root"></div>`
  // VUOTO (signature pre-hydration), ma Playwright cattura il DOM gia'
  // RENDERIZZATO con contenuto dentro, quindi `<div id="root"><h1>...`
  // sfugge a detectSpa anche se la pagina e' di fatto un'app Vite/React.
  // Includiamo detectModernSpa nel trigger per fermare questo edge case.
  const modernSpaCheck = detectModernSpa(originalHtml, sourceUrl);
  const isModernSpa = modernSpaCheck.isModern;
  // Auto-keep content-generating scripts: some funnel pages build whole
  // sections in JS (fake live chat / comments, viewer counter, countdown,
  // FOMO toasts). Stripping them leaves empty containers, so in AUTO mode
  // (applySpaPreviewMode neither true nor false) we DON'T strip when such
  // functional scripts are detected — even if the page also looks SPA-ish.
  // Explicit applySpaPreviewMode===true (force strip) / ===false (force keep)
  // still win.
  const dynScriptCheck = detectDynamicScripts(originalHtml);
  const hasFunctionalScripts = dynScriptCheck.functional;
  const previewModeRequested =
    applySpaPreviewMode === true ||
    (applySpaPreviewMode !== false && (isSpa || isModernSpa) && !hasFunctionalScripts);
  // Helper: inietta `content` prima di `closeTag` SENZA interpretare $&/$1
  // nel content (callback form di String.prototype.replace). Se `dedupRe`
  // viene passato, rimuove tutte le occorrenze precedenti dello stesso
  // tipo di nodo per evitare iniezioni cumulative quando finalize viene
  // richiamato piu' volte sullo stesso HTML (utente che fa "Riscrivi"
  // ripetutamente sulla stessa pagina cloned).
  //
  // BUG STORICO ($& in swipeScript): replace('</body>', swipeScript + '</body>')
  // con secondo argomento STRINGA fa interpretare `$&` (presente nel
  // template letterale del swipeScript) come back-reference al match —
  // risultato `'\\$&'` → `'\\</body>'`, SyntaxError nel browser, replacement
  // mai applicati lato client.
  function safeInjectBefore(htmlStr, closeTag, content, dedupRe) {
    let out = htmlStr;
    if (dedupRe) out = out.replace(dedupRe, '');
    if (out.includes(closeTag)) {
      // callback form → niente espansione di $&/$1 nel content
      out = out.replace(closeTag, () => content + closeTag);
    } else {
      out += content;
    }
    return out;
  }
  function safeInjectAfterRe(htmlStr, openRe, content) {
    if (openRe.test(htmlStr)) {
      openRe.lastIndex = 0;
      return htmlStr.replace(openRe, (m) => content + m);
    }
    return content + htmlStr;
  }
  let scriptStripStats = null;
  if (previewModeRequested) {
    const strip = stripOriginalScripts(preparedHtml);
    scriptStripStats = { before: strip.scriptsBefore, after: strip.scriptsAfter };
    preparedHtml = strip.html;
    // FAQ CSS + navigation fix nel <head>; fallback init prima di </body>.
    // Dedup-RE: matcha qualsiasi <style data-fallback="..."> o
    // <script data-fallback="..."> inserito da una run precedente di
    // finalize, cosi' non si moltiplicano se l'HTML cloned viene
    // riprocessato.
    const FALLBACK_DEDUP_RE = /<(?:style|script)\b[^>]*\bdata-fallback=("|')[^"']+\1[^>]*>[\s\S]*?<\/(?:style|script)>/gi;
    preparedHtml = preparedHtml.replace(FALLBACK_DEDUP_RE, '');
    const headInjection = FAQ_CSS_OVERRIDE + LAYOUT_OVERFLOW_FIX + NEXTJS_NAVIGATION_FIX;
    if (preparedHtml.includes('</head>')) {
      preparedHtml = safeInjectBefore(preparedHtml, '</head>', headInjection);
    } else if (/<body[^>]*>/.test(preparedHtml)) {
      preparedHtml = safeInjectAfterRe(preparedHtml, /<body[^>]*>/, headInjection);
    } else {
      preparedHtml = headInjection + preparedHtml;
    }
    preparedHtml = safeInjectBefore(preparedHtml, '</body>', FALLBACK_INIT_SCRIPT);
  } else {
    // Scripts kept (functional page: live chat/comments, counter, countdown).
    // Undo Cloudflare Rocket Loader so those inline scripts run natively on the
    // cloned origin instead of waiting for a rocket-loader.min.js that 404s.
    // No-op on pages that don't use Rocket Loader.
    const neutralized = neutralizeRocketLoader(preparedHtml);
    preparedHtml = neutralized.html;
  }

  // Dedup swipe-replacer da run precedenti (idempotenza su re-finalize).
  //
  // Doppio sweep:
  // 1. Rimuove blocchi <script data-swipe-replacer>...</script> ben formati
  //    (caso normale)
  // 2. Rimuove "tail orfani" lasciati nell'HTML da run precedenti del bug
  //    $& storico — quando il vecchio codice faceva
  //    `replace('</body>', swipeScript + '</body>')` con stringa, il `$&`
  //    dentro lo swipeScript template (`'\\$&'`) veniva espanso a
  //    `'\\</body>'`. Ogni "Riscrivi" successivo trovava quel `</body>`
  //    letterale dentro la stringa quotata e ci infilava DENTRO un nuovo
  //    swipeScript, generando swipe-replacer nidificati. Quando il dedup
  //    "ben formato" rimuove il primo livello, restano dei frammenti
  //    orfani del template (function normWS / var prepared / applyAll /
  //    polling timer / `})();</script></body>');}`) che NON cominciano
  //    con `<script data-swipe-replacer>` ma sono comunque "spazzatura"
  //    visibile dal browser come testo nel body.
  //    Il regex `SWIPE_REPLACER_ORPHAN_RE` cerca il pattern di "coda" del
  //    bug: `</body>');}` immediatamente seguito da `function normWS(`,
  //    che e' una signature univoca del nostro template — nessun sito
  //    legittimo lo contiene.
  const SWIPE_REPLACER_DEDUP_RE = /<script\b[^>]*\bdata-swipe-replacer\b[^>]*>[\s\S]*?<\/script>/gi;
  const SWIPE_REPLACER_ORPHAN_RE = /<\/body>'\);\}[\s\S]*?function normWS\(s\)\{[\s\S]*?<\/script>/gi;
  preparedHtml = preparedHtml.replace(SWIPE_REPLACER_DEDUP_RE, '');
  preparedHtml = preparedHtml.replace(SWIPE_REPLACER_ORPHAN_RE, '');

  // BUG STORICO — Auto-riparazione meta viewport corrotto.
  // Pagine processate da release precedenti del worker possono avere il
  // `<meta name="viewport" content="...">` con un content valorizzato a
  // testo libero (output LLM tipo "Aspetta, credo ci sia un malinteso...")
  // perche' all'epoca il filtro `SAFE_META_NAMES` nelle route Next.js non
  // c'era. Risultato: il browser non applica un viewport responsive e la
  // pagina renderizza con scrollbar orizzontale, tutto microscopico su
  // mobile, layout completamente rotto. Il filtro nuovo previene altre
  // corruzioni, ma le pagine GIA' rotte rimangono rotte ad ogni nuovo
  // Riscrivi (il filtro le ignora correttamente, ma non le ripara).
  // Heuristica: se il content del viewport NON contiene almeno una keyword
  // tipica (`width=`, `device-width`, `initial-scale=`, `user-scalable=`,
  // `viewport-fit=`), assumiamo corruzione e ripristiniamo il default
  // responsive standard. Falsi positivi praticamente impossibili: un sito
  // legittimo non valorizza il viewport con frasi in linguaggio naturale.
  const VIEWPORT_RE = /<meta\b([^>]*?)\bname\s*=\s*(["'])viewport\2([^>]*?)\bcontent\s*=\s*(["'])([^"']*)\4([^>]*)>/gi;
  const VIEWPORT_SAFE_DEFAULT = 'width=device-width, initial-scale=1';
  const VIEWPORT_TOKEN_RE = /\b(?:width|device-width|initial-scale|maximum-scale|minimum-scale|user-scalable|viewport-fit)\b/i;
  preparedHtml = preparedHtml.replace(VIEWPORT_RE, (full, a1, q1, a2, q2, content, a3) => {
    if (VIEWPORT_TOKEN_RE.test(content)) return full;
    return `<meta${a1}name=${q1}viewport${q1}${a2}content=${q2}${VIEWPORT_SAFE_DEFAULT}${q2}${a3}>`;
  });
  // Stesso fix con name/content invertiti (`content="..." name="viewport"`).
  const VIEWPORT_RE_INV = /<meta\b([^>]*?)\bcontent\s*=\s*(["'])([^"']*)\2([^>]*?)\bname\s*=\s*(["'])viewport\5([^>]*)>/gi;
  preparedHtml = preparedHtml.replace(VIEWPORT_RE_INV, (full, a1, q1, content, a2, q2, a3) => {
    if (VIEWPORT_TOKEN_RE.test(content)) return full;
    return `<meta${a1}content=${q1}${VIEWPORT_SAFE_DEFAULT}${q1}${a2}name=${q2}viewport${q2}${a3}>`;
  });

  // BUG STORICO — Doppio escape `&amp;amp;` negli URL inlinati.
  // Origine: in qualche pipeline a monte il valore href era gia' HTML-encoded
  // (`&amp;`) e una pass di `escapeHtml` lo ha re-encodato a `&amp;amp;`.
  // Effetto visibile nell'HTML: `<style data-inlined-from="...&amp;amp;family=...">`.
  // Quando il browser legge l'attributo, decodifica una sola volta → ottiene
  // `&amp;` letterale come parte dell'URL (sbagliato: l'URL valido contiene
  // `&` semplice). Il fix in `worker-lib/inline-css.js` (decode loop) previene
  // il problema per i nuovi clone, ma esistono HTML gia' rotti in archivio.
  // Questo collapse difensivo riduce `&amp;amp;` → `&amp;` SOLO dentro attributi
  // `data-inlined-from` e `data-inlined-bytes`, dove non possono esserci `&amp;`
  // letterali legittimi (sono URL). Non tocca testo libero ne' altri attributi.
  preparedHtml = preparedHtml.replace(
    /\bdata-inlined-from\s*=\s*(["'])([^"']*)\1/gi,
    (full, q, val) => {
      let v = val;
      let prev;
      do {
        prev = v;
        v = v.replace(/&amp;amp;/gi, '&amp;');
      } while (v !== prev);
      return `data-inlined-from=${q}${v}${q}`;
    },
  );
  // Build marker visibile nell'HTML finale — utile per diagnosticare se
  // il worker sta girando codice aggiornato dopo un restart. Cerca
  // `data-finalize-build=` nell'HTML per vedere la versione attiva.
  const FINALIZE_BUILD = 'worker-finalize-v3-viewport-autorepair-amp-collapse-2026-05-28';
  const buildMarker = `<meta data-finalize-build="${FINALIZE_BUILD}">`;
  preparedHtml = preparedHtml.replace(/<meta data-finalize-build="[^"]*">/gi, '');
  if (preparedHtml.includes('</head>')) {
    preparedHtml = preparedHtml.replace('</head>', () => buildMarker + '</head>');
  }
  let resultHtml = safeInjectBefore(
    preparedHtml,
    '</body>',
    swipeScript,
  );

  // Apply live-chat comment rewrites into the `var TIMED = [...]` array
  // (server-side: they live in a <script>, invisible to the DOM replacer).
  let commentReplacements = 0;
  if (commentRewrites.size > 0) {
    try {
      const cr = applyTimedCommentRewrites(resultHtml, commentRewrites);
      resultHtml = cr.html;
      commentReplacements = cr.replaced;
    } catch { /* no-op */ }
  }

  const newTitle = serverSideTitlePairs[0]?.to
    || (texts.length > 0 ? replacementPairs.find((p) => !p.attr)?.to || '' : '');
  const totalReplacements = replacementPairs.length + serverSideTitlePairs.length
    + serverSideMetaPairs.length + commentReplacements;

  return {
    success: true,
    html: resultHtml,
    original_title: originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
    new_title: newTitle,
    original_length: originalHtml.length,
    new_length: resultHtml.length,
    totalTexts: texts.length,
    replacements: totalReplacements,
    replacements_dom: replacementPairs.length,
    replacements_title: serverSideTitlePairs.length,
    replacements_meta: serverSideMetaPairs.length,
    replacements_comments: commentReplacements,
    replacements_server_side_html: serverReplacementsCount,
    replacements_server_side_fuzzy: fuzzyReplacementsCount,
    is_spa_page: isSpa,
    spa_safety_strips: spaSafetyStrips,
    spa_preview_mode_applied: previewModeRequested,
    spa_preview_script_strip: scriptStripStats,
    // Telemetria modern-SPA — informativa, NON cambia il flow (lo strip
    // si applica comunque, vedi commento sopra). reason indica quale
    // signature ha matchato (vite_module / replit_host / lovable_host /
    // all_module_scripts) — utile per capire dal log che tipo di pagina
    // sta arrivando dal wild.
    modern_spa_detected: isModernSpa,
    modern_spa_reason: modernSpaCheck.reason,
    // Content-generating scripts kept because the page builds sections in JS
    // (live chat/comments, counters, countdown). See previewModeRequested.
    functional_scripts_detected: hasFunctionalScripts,
    functional_script_signals: dynScriptCheck.signals,
    asset_urls_absolutized: Boolean(sourceUrl),
    unresolved_text_ids: unresolvedIds,
    coverage_ratio: texts.length ? totalReplacements / texts.length : 0,
    provider: 'openclaw-local-inproc',
    method_used: 'universal-extract+dom-replacement-batched (worker in-process)',
    changes_made: replacementPairs.map((p) => ({
      from: p.from.substring(0, 50),
      to: p.to.substring(0, 50),
    })),
    finalize_duration_ms: Date.now() - t0,
    sourceUrl: sourceUrl ?? null,
  };
}

module.exports = { finalizeSwipe };
