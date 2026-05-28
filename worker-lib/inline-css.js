/**
 * worker-lib/inline-css.js
 * ─────────────────────────────────────────────────────────────────
 * Scarica gli stylesheet esterni (<link rel="stylesheet" href="...">)
 * e li INLINIZZA dentro l'HTML come <style>...</style>.
 *
 * PERCHE' SERVE:
 *   Le pagine moderne (Replit/Vite, Lovable, Next.js, CheckoutChamp,
 *   Funnelish, ecc.) servono il CSS via tag esterni tipo:
 *     <link rel="stylesheet" crossorigin href="/assets/index-XXX.css">
 *
 *   Quando il NOSTRO worker clona la pagina e l'HTML viene poi servito
 *   da un dominio diverso (Wasabi preview, Supabase Storage, dominio
 *   cliente, iframe srcdoc del preview, Netlify) il browser:
 *     1. fa CORS check per via dell'attributo `crossorigin` →
 *        bloccato se l'origine non manda Access-Control-Allow-Origin
 *        (Replit/Lovable NON lo mandano)
 *     2. fa richiesta cross-origin che puo' essere bloccata da CSP
 *        dell'host che serve l'HTML (es. base-uri 'self')
 *     3. anche tolti tutti i blocchi, il rendering dipende dalla
 *        disponibilita' run-time della CSS sull'origine → fragile
 *
 *   Risultato: pagina "tutta sconfusionata" perche' il CSS non viene
 *   mai applicato. Layout collassa, niente Tailwind, niente nulla.
 *
 * COSA FACCIAMO QUI:
 *   1. Parsiamo l'HTML cercando <link rel="stylesheet" href="...">
 *   2. Per ogni href, risolviamo a URL assoluto contro sourceUrl
 *   3. Facciamo fetch (Node fetch — niente CORS, e' server-side)
 *   4. Riscriviamo gli url(...) interni al CSS in modo che puntino
 *      all'origine (i path relativi nel CSS erano relativi al file
 *      CSS, non all'HTML — dobbiamo risolverli contro il path del CSS)
 *   5. Sostituiamo il <link> con <style data-inlined-from="...">CSS</style>
 *
 * BENEFICI:
 *   - Zero richieste cross-origin per il CSS → CORS/CSP non rompono nulla
 *   - HTML autonomo: funziona anche se domani Replit chiude il server
 *   - Preview deterministico (snapshot del CSS al momento del clone)
 *   - Funziona ovunque venga servito l'HTML (Storage, iframe, dominio
 *     cliente, on-premise)
 *
 * LIMITI ACCETTABILI:
 *   - I @font-face che puntano a /assets/*.woff2 sull'origine possono
 *     fallire perche' i font triggerano CORS anche senza attributo
 *     `crossorigin` (font fingerprinting protection). Fallback browser
 *     → font di sistema. Layout integro, solo tipografia generica.
 *   - File CSS grossi (Tailwind ~80-200KB) → HTML cresce di 100-300KB.
 *     Accettabile: Storage e' veloce, e e' un costo una-tantum a swipe.
 */

'use strict';

// Limiti difensivi: non vogliamo che una CSS gigante blocchi il worker
// ne' che un fetch lento congeli tutta la pipeline di swipe.
const PER_CSS_TIMEOUT_MS = 15_000;
const PER_CSS_MAX_BYTES = 5 * 1024 * 1024; // 5MB hard cap per file
const TOTAL_INLINE_BUDGET_MS = 30_000; // tutta l'operazione si chiude in 30s max

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Riscrive gli `url(...)` interni al CSS in modo che puntino all'URL
// originale del file CSS (i path relativi erano relativi a *quello*,
// non all'HTML che li conterra' una volta inlinati).
//
// Skippa esplicitamente: data:, blob:, http(s)://, //, e #.
function rewriteCssUrls(css, cssUrl) {
  if (!css || !cssUrl) return css;
  return css.replace(
    /url\(\s*(['"]?)([^)\s'"]+)\1\s*\)/g,
    (full, quote, urlVal) => {
      const v = (urlVal || '').trim();
      if (!v) return full;
      if (/^(data:|blob:|https?:\/\/|\/\/|#)/i.test(v)) return full;
      try {
        const absolute = new URL(v, cssUrl).toString();
        return `url(${quote}${absolute}${quote})`;
      } catch {
        return full;
      }
    },
  );
}

// Riscrive anche le @import che usano la sintassi senza url():
//   @import "/assets/foo.css";
//   @import 'foo.css';
// Le @import url(...) sono gia' catturate da rewriteCssUrls.
function rewriteCssImports(css, cssUrl) {
  if (!css || !cssUrl) return css;
  return css.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (full, quote, urlVal) => {
      const v = (urlVal || '').trim();
      if (!v) return full;
      if (/^(data:|https?:\/\/|\/\/)/i.test(v)) return full;
      try {
        const absolute = new URL(v, cssUrl).toString();
        return `@import ${quote}${absolute}${quote}`;
      } catch {
        return full;
      }
    },
  );
}

async function fetchCssSafe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CSS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/css,*/*;q=0.1' },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > PER_CSS_MAX_BYTES) {
      return { ok: false, error: `too big (${buf.byteLength} bytes)` };
    }
    const css = Buffer.from(buf).toString('utf8');
    return { ok: true, css, bytes: buf.byteLength };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trova i <link rel="stylesheet" href="..."> dentro l'HTML e ritorna
 * una lista di candidati con il tag completo, l'href grezzo, e l'URL
 * assoluto risolto. NON modifica l'HTML.
 *
 * Robusto contro:
 *   - attributi in ordine diverso (rel prima o dopo href)
 *   - rel senza virgolette (rel=stylesheet)
 *   - attributi con caratteri di escape minori
 *   - tag con altre keyword in rel (es. rel="stylesheet preload")
 *
 * Skippa:
 *   - href vuoti o data:/blob:/javascript:/#/mailto:/tel:
 *   - link senza rel=stylesheet
 *   - link con disabled attribute
 */
// HTML entity decode dei soli pattern che possono apparire in attributi
// `href` standard. Necessario perche' regex-scrape estrae il VALORE
// HTML-encoded ("?family=A&amp;family=B") e ne fa l'URL: senza decode,
// `new URL("https://x.com/?a=1&amp;b=2")` tiene `&amp;` letterale,
// e poi quando ri-emettiamo `data-inlined-from="${rawHref}"` con un
// escapeHtml otteniamo `&amp;amp;` (doppio escape).
function decodeHtmlEntities(s) {
  if (!s || typeof s !== 'string') return s;
  let out = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
  // BUG STORICO: `&amp;` DEVE essere decodificato in LOOP fino a stato stabile.
  // Un single-pass replace(/&amp;/g, '&') trasforma `&amp;amp;` in `&amp;`
  // (NON in `&`), perche' String.prototype.replace con flag /g/ scansiona il
  // TESTO ORIGINALE una sola volta — non re-itera sui caratteri sostituiti.
  // Per gli URL Google Fonts su Replit/Vite, l'HTML upstream arriva gia'
  // doppio-encoded (`&amp;amp;`) perche' un altro step di pipeline ha gia'
  // fatto un escapeHtml su un href che era gia' `&amp;`. Senza il loop, il
  // doppio-encode non viene mai risolto e il browser fa fetch su un URL
  // letterale `?family=A&amp;family=B` (query string sbagliata, font missing).
  // Test: 'A&amp;amp;B' → loop 1: 'A&amp;B' → loop 2: 'A&B' → loop 3 = uguale, stop.
  let prev;
  do {
    prev = out;
    out = out.replace(/&amp;/gi, '&');
  } while (out !== prev);
  return out;
}

function findStylesheetCandidates(html, baseUrl) {
  if (!html || !baseUrl) return [];
  const out = [];
  const seenAbs = new Set(); // dedupe per URL

  // Match generico di <link ...> — la regex e' permissiva, poi controlliamo
  // gli attributi dentro al body del tag.
  const linkRe = /<link\b([^>]*)>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const attrs = m[1] || '';

    // Disabled? skip.
    if (/\bdisabled\b/i.test(attrs)) continue;

    // Rel deve contenere "stylesheet" (case-insensitive, anche senza quotes).
    const relM = attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!relM) continue;
    const relVal = (relM[1] || relM[2] || relM[3] || '').toLowerCase();
    if (!/\bstylesheet\b/.test(relVal)) continue;

    // Href RAW (com'è nel sorgente HTML, eventualmente con entity).
    const hrefM = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefM) continue;
    const rawHrefEncoded = (hrefM[1] || hrefM[2] || hrefM[3] || '').trim();
    if (!rawHrefEncoded) continue;
    if (/^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(rawHrefEncoded)) continue;

    // Decode entity HTML PRIMA di risolvere come URL. Senza questo, un href
    // tipo `?family=A&amp;family=B` viene passato a `new URL` con `&amp;`
    // letterale → query string sbagliata, fetch sbagliato, font che non
    // caricano. E in piu' poi finisce in `data-inlined-from="..."` con
    // un secondo escapeHtml → `&amp;amp;` (doppio escape, gia' visto in
    // produzione su lander Replit/Vite con Google Fonts).
    const rawHref = decodeHtmlEntities(rawHrefEncoded);

    let absUrl;
    try {
      absUrl = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }

    if (seenAbs.has(absUrl)) continue;
    seenAbs.add(absUrl);

    out.push({ tag, attrs, rawHref, rawHrefEncoded, absUrl });
  }
  return out;
}

/**
 * Scarica e inlinizza tutti gli stylesheet esterni dell'HTML.
 *
 * @param {string} html — HTML grezzo (come arriva da Playwright o storage)
 * @param {string} sourceUrl — URL della pagina d'origine (per risolvere
 *                              href relativi). Se mancante, no-op.
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]
 * @param {(msg:string)=>void} [opts.warn]
 *
 * @returns {Promise<{
 *   html: string,
 *   inlined: number,
 *   failed: number,
 *   skipped: number,
 *   totalBytes: number,
 *   errors: string[],
 *   sources: string[],
 * }>}
 */
async function inlineExternalStylesheets(html, sourceUrl, opts = {}) {
  const log = opts.log || (() => {});
  const warn = opts.warn || (() => {});

  const empty = {
    html: html || '',
    inlined: 0,
    failed: 0,
    skipped: 0,
    totalBytes: 0,
    errors: [],
    sources: [],
  };

  if (!html || typeof html !== 'string') return empty;
  if (!sourceUrl) {
    warn('inline-css: sourceUrl mancante — skip');
    return empty;
  }

  let baseUrl;
  try {
    baseUrl = new URL(sourceUrl).href;
  } catch {
    warn(`inline-css: sourceUrl invalido (${sourceUrl}) — skip`);
    return empty;
  }

  const candidates = findStylesheetCandidates(html, baseUrl);
  if (candidates.length === 0) {
    log('inline-css: nessun <link rel="stylesheet"> trovato — skip');
    return empty;
  }

  log(`inline-css: trovati ${candidates.length} stylesheet esterni, scarico in parallelo…`);

  // Race tra fetch-paralleli e budget totale. Se sforiamo il budget,
  // teniamo solo le CSS che sono arrivate in tempo.
  const startedAt = Date.now();
  const fetches = candidates.map(async (c) => {
    const r = await fetchCssSafe(c.absUrl);
    return { candidate: c, result: r };
  });

  // Promise.race tra "tutte le fetch" e "timeout globale"
  let resolved;
  try {
    resolved = await Promise.race([
      Promise.all(fetches),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`global timeout dopo ${TOTAL_INLINE_BUDGET_MS}ms`)),
          TOTAL_INLINE_BUDGET_MS,
        ),
      ),
    ]);
  } catch (e) {
    warn(`inline-css: ${e.message} — provo a recuperare i settled in flight`);
    // Fallback: prendiamo solo i Promise gia' settled.
    resolved = await Promise.allSettled(fetches).then((arr) =>
      arr
        .filter((p) => p.status === 'fulfilled')
        .map((p) => p.value),
    );
  }

  const elapsedMs = Date.now() - startedAt;

  // Applichiamo le sostituzioni dall'ULTIMA alla PRIMA cosi' gli indici
  // restano stabili (sostituire dalla prima muoverebbe le posizioni
  // delle successive). Pero', dato che usiamo indexOf, lavoriamo sulle
  // stringhe esatte: per evitare collisioni se due tag identici esistono,
  // teniamo conto di un offset progressivo.
  let working = html;
  let inlined = 0;
  let failed = 0;
  let totalBytes = 0;
  const errors = [];
  const sources = [];

  for (const r of resolved) {
    const { candidate, result } = r;
    if (!result.ok) {
      failed++;
      errors.push(`${candidate.absUrl}: ${result.error}`);
      warn(`inline-css: ✗ ${candidate.absUrl} — ${result.error}`);
      continue;
    }
    let css = result.css;
    css = rewriteCssUrls(css, candidate.absUrl);
    css = rewriteCssImports(css, candidate.absUrl);

    const replacement =
      `<style data-inlined-from="${escapeHtml(candidate.absUrl)}" data-inlined-bytes="${result.bytes}">\n` +
      `/* inlined from ${candidate.absUrl} */\n` +
      `${css}\n` +
      `</style>`;

    const idx = working.indexOf(candidate.tag);
    if (idx === -1) {
      // Tag non piu' trovato (forse e' stato modificato da una pass precedente).
      // Tentiamo un match piu' lasco basato sull'href esatto.
      // ATTENZIONE: per il match nell'HTML originale serve la versione
      // ENCODED dell'href (quella con &amp;), perche' l'HTML che stiamo
      // ispezionando contiene le entity grezze. Se usassimo `rawHref`
      // (decoded) avremmo un mancato match su qualunque href con `&`.
      const hrefForMatch = candidate.rawHrefEncoded || candidate.rawHref;
      const looseRe = new RegExp(
        '<link\\b[^>]*?\\bhref\\s*=\\s*["\']' +
          hrefForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '["\'][^>]*>',
        'i',
      );
      const looseM = working.match(looseRe);
      if (!looseM) {
        failed++;
        errors.push(`${candidate.absUrl}: tag <link> non piu' trovato in HTML`);
        warn(`inline-css: ✗ ${candidate.absUrl} — tag <link> sparito dopo altre pass`);
        continue;
      }
      working = working.replace(looseM[0], replacement);
    } else {
      working =
        working.substring(0, idx) +
        replacement +
        working.substring(idx + candidate.tag.length);
    }

    inlined++;
    totalBytes += result.bytes;
    sources.push(candidate.absUrl);
    log(`inline-css: ✓ ${candidate.absUrl} (${(result.bytes / 1024).toFixed(1)} KB)`);
  }

  const skipped = candidates.length - resolved.length;
  if (skipped > 0) {
    warn(`inline-css: ${skipped} stylesheet NON scaricati per timeout globale (${elapsedMs}ms)`);
  }

  log(
    `inline-css: done — ${inlined} inlined / ${failed} falliti / ${skipped} skippati (timeout), ` +
      `${(totalBytes / 1024).toFixed(1)} KB CSS totali, ${elapsedMs}ms`,
  );

  return {
    html: working,
    inlined,
    failed,
    skipped,
    totalBytes,
    errors,
    sources,
  };
}

module.exports = {
  inlineExternalStylesheets,
  // Esportati per i test
  findStylesheetCandidates,
  rewriteCssUrls,
  rewriteCssImports,
};
