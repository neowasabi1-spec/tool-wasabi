// worker-lib/bundle-extractor.js
//
// Estrae stringhe "umane" dai bundle JavaScript di Next.js (e simili) per
// catturare il copy dei quiz/funnel CSR puri (es. Bioma Health, Typeform-like).
// Su queste pagine __NEXT_DATA__ e l'HTML SSR sono quasi vuoti: domande,
// opzioni, label bottoni, headline VIVONO solo dentro
//   /_next/static/chunks/pages/[funnel]/[page]-HASH.js
//
// Pipeline:
//   1. trova <script src="/_next/static/chunks/pages/.../something.js">
//      (whitelist solo bundle delle pagine, skip framework/main/runtime/_app/_document)
//   2. scarica ogni bundle in parallelo con timeout 15s, max 5MB
//   3. estrae string literals "..." '...' `...` con filtri pesanti:
//      length 10-280, inizia con lettera, ha spazio, ha 3+ lettere consecutive,
//      non e' URL/path/uuid/className/CONSTANT/camelCaseSenzaSpazi.
//   4. ritorna texts marcati con context='js-bundle' e _bundleUrl per la
//      fase di inlining che li rimettera' dentro il bundle modificato.
//
// Porting fedele della logica nella Deno Edge Function `clone-competitor`.

const BUNDLE_TIMEOUT_MS = parseInt(process.env.OPENCLAW_BUNDLE_FETCH_TIMEOUT_MS || '15000', 10);
const BUNDLE_MAX_BYTES = parseInt(process.env.OPENCLAW_BUNDLE_MAX_BYTES || '5000000', 10);
const BUNDLE_MAX_COUNT = parseInt(process.env.OPENCLAW_BUNDLE_MAX_COUNT || '8', 10);
const USER_AGENT = 'Mozilla/5.0 (compatible; OpenClawWorker/1.0)';

function findBundleUrls(html, baseUrl) {
  if (!html || typeof html !== 'string') return [];
  const bundleScriptRegex = /<script\b[^>]*\bsrc=["']([^"']*\/_next\/static\/chunks\/[^"']+\.js[^"']*)["'][^>]*>/gi;
  const urls = new Set();
  let m;
  while ((m = bundleScriptRegex.exec(html)) !== null) {
    const src = m[1];
    const isPageBundle = /\/_next\/static\/chunks\/pages\//.test(src);
    // Bundle framework/runtime: contengono codice generico di Next.js, error
    // boundary messages, polyfills. Non hanno copy specifico della pagina,
    // estrarli vuol dire flooddare l'LLM con stringhe inutili.
    const isFrameworkBundle =
      /\/(?:main|webpack|polyfills|framework|runtime)[-.]/i.test(src) ||
      /\/pages\/_(?:app|document|error|middleware)/.test(src);
    if (!isPageBundle || isFrameworkBundle) continue;
    let absUrl;
    try { absUrl = new URL(src, baseUrl || 'https://localhost').href; }
    catch { continue; }
    urls.add(absUrl);
  }
  return Array.from(urls).slice(0, BUNDLE_MAX_COUNT);
}

async function fetchBundleSafe(bundleUrl) {
  let controller;
  let timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), BUNDLE_TIMEOUT_MS);
    const res = await fetch(bundleUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const body = await res.text();
    if (body.length > BUNDLE_MAX_BYTES) {
      return { ok: false, status: 'too_large', body: null, size: body.length };
    }
    return { ok: true, status: res.status, body, size: body.length };
  } catch (e) {
    return { ok: false, status: 'fetch_error', body: null, error: e.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Pattern usato sia per estrazione che per inlining. Cattura string literals
// JavaScript "..." '...' `...` escape-aware (no greedy).
const JS_STRING_REGEX_GLOBAL = () => /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;

function isHumanLikeJsString(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 10 || s.length > 280) return false;
  if (!/[A-Za-z]/.test(s.charAt(0))) return false;
  if (!/\s/.test(s)) return false; // serve almeno uno spazio
  if (!/[a-zA-Z]{3,}\s+[a-zA-Z]{2,}/.test(s)) return false; // almeno 2 parole reali
  if (/[<>{}\\=;|]/.test(s)) return false; // markup/code
  if (/^https?:\/\//i.test(s)) return false;
  if (/\.(js|css|png|jpe?g|svg|webp|woff2?|ttf|json|map|wasm)(\?|$)/i.test(s)) return false;
  if (s.includes('node_modules')) return false;
  if (s.includes('webpack')) return false;
  if (/^[A-Z_][A-Z0-9_]+$/.test(s)) return false; // CONSTANT_CASE
  if (/^[a-z]+([A-Z][a-z]+){2,}$/.test(s) && !s.includes(' ')) return false; // camelCase senza spazi
  return true;
}

function extractStringsFromBundleSource(js) {
  if (!js || typeof js !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = JS_STRING_REGEX_GLOBAL();
  let m;
  while ((m = re.exec(js)) !== null) {
    const s = m[2];
    if (!isHumanLikeJsString(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Scarica i bundle JS della pagina ed estrae le stringhe rilevanti.
 *
 * Ritorna: Array<{ text, context, position, _bundleUrl }>
 *   context: sempre 'js-bundle'
 *   position: 90000 + index (pushed in fondo all'ordine generale)
 *   _bundleUrl: serve a inlineBundleRewrites per raggruppare i rewrite e
 *               rifare la fetch e l'inline.
 *
 * Non lancia mai: in caso di errore ritorna lista vuota (best-effort).
 */
async function extractBundleTexts(html, sourceUrl, { log = () => {}, warn = () => {} } = {}) {
  const bundleUrls = findBundleUrls(html, sourceUrl);
  if (bundleUrls.length === 0) return [];
  log(`  · bundle-extractor: trovati ${bundleUrls.length} bundle Next.js pages/* (sourceUrl=${sourceUrl || '?'})`);
  const results = await Promise.all(bundleUrls.map(async (url) => {
    const r = await fetchBundleSafe(url);
    if (!r.ok) {
      warn(`    ⚠️  bundle ${url} skipped: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      return { url, strings: [] };
    }
    const strings = extractStringsFromBundleSource(r.body);
    log(`    ✓ bundle ${url.split('/').pop()} ${r.size}b → ${strings.length} stringhe umane`);
    return { url, strings };
  }));
  const allTexts = [];
  let pos = 90000;
  const globalSeen = new Set();
  for (const { url, strings } of results) {
    for (const s of strings) {
      if (globalSeen.has(s)) continue;
      globalSeen.add(s);
      allTexts.push({
        text: s,
        context: 'js-bundle',
        position: pos++,
        _bundleUrl: url,
      });
    }
  }
  log(`  · bundle-extractor: totale ${allTexts.length} stringhe uniche da ${bundleUrls.length} bundle`);
  return allTexts;
}

module.exports = {
  extractBundleTexts,
  findBundleUrls,
  extractStringsFromBundleSource,
  isHumanLikeJsString,
  fetchBundleSafe,
  JS_STRING_REGEX_GLOBAL,
};
