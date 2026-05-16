// worker-lib/bundle-inliner.js
//
// Post-finalize step: per ogni testo riscritto che era stato estratto da un
// bundle JS Next.js (texts.tag === 'js-bundle'), rifa la fetch del bundle
// originale, sostituisce le stringhe riscritte (replace SAFE solo dentro
// string literal "..." '...' `...`), e inline-a il bundle modificato
// nell'HTML al posto del <script src="..."> originale.
//
// In questo modo i quiz/funnel CSR puri (Bioma) eseguono il bundle
// MODIFICATO e l'utente vede le domande/risposte/CTA riscritte.
//
// Funziona in coppia con bundle-extractor: l'extractor marca i texts con
// _bundleUrl, il worker conserva quel campo nel mapping promptTexts, e il
// inliner usa quel campo per raggruppare i rewrite e fetchare il bundle
// giusto.
//
// E' un best-effort: qualunque errore non blocca il save dell'HTML.

const { fetchBundleSafe } = require('./bundle-extractor');

function escRxLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyReplacementsToBundle(bundleJs, replacements) {
  let js = bundleJs;
  let applied = 0;
  for (const { orig, rewr } of replacements) {
    if (!orig || !rewr || orig === rewr) continue;
    const escOrig = escRxLiteral(orig);
    let replacedHere = false;
    for (const quote of ['"', "'", '`']) {
      const re = new RegExp(`${quote === '`' ? '`' : quote}${escOrig}${quote === '`' ? '`' : quote}`, 'g');
      if (re.test(js)) {
        // Reset lastIndex perche' test() sopra l'ha consumato
        re.lastIndex = 0;
        // Quote-aware escape per il contenuto della replacement
        let escRewr;
        if (quote === '`') {
          escRewr = rewr.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        } else {
          escRewr = rewr.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
        }
        js = js.replace(re, `${quote}${escRewr}${quote}`);
        applied++;
        replacedHere = true;
        break;
      }
    }
    if (!replacedHere) {
      // Fallback senza quote: solo se la stringa e' unica nel bundle
      // (evita di rompere code paths casuali in template letterali).
      const occurrences = (js.match(new RegExp(escRxLiteral(orig), 'g')) || []).length;
      if (occurrences === 1) {
        js = js.split(orig).join(rewr);
        applied++;
      }
    }
  }
  return { js, applied };
}

function inlineBundleInHtml(html, bundleUrl, modifiedJs) {
  // Replace <script src="<bundleUrl>"></script> with <script>...</script>
  // contenente il bundle modificato. Match sia l'URL assoluto sia il path
  // relativo perche' nell'HTML originale possono apparire entrambi.
  const escBundleUrlAbs = escRxLiteral(bundleUrl);
  let escBundleUrlRel = null;
  try {
    const u = new URL(bundleUrl);
    escBundleUrlRel = escRxLiteral(u.pathname + (u.search || ''));
  } catch {/* ignore */}
  const candidates = [escBundleUrlAbs];
  if (escBundleUrlRel && escBundleUrlRel !== escBundleUrlAbs) candidates.push(escBundleUrlRel);

  // Escape </script in JS body altrimenti il parser HTML chiude lo script
  // a meta' codice.
  const safeJs = modifiedJs.replace(/<\/script/gi, '<\\/script');
  const bundleBaseName = (() => {
    try { return new URL(bundleUrl).pathname.split('/').pop() || 'bundle.js'; } catch { return 'bundle.js'; }
  })();
  const inlineTag = `<script data-inlined-bundle="${bundleBaseName}">/* inlined bundle: ${bundleBaseName} */\n${safeJs}\n</script>`;

  let replaced = false;
  let out = html;
  for (const pattern of candidates) {
    const re = new RegExp(`<script\\b[^>]*\\bsrc=["']${pattern}["'][^>]*>\\s*<\\/script>`, 'gi');
    const next = out.replace(re, () => { replaced = true; return inlineTag; });
    out = next;
    if (replaced) break;
  }
  return { html: out, replaced };
}

/**
 * Inline-a i rewrite dei bundle JS dentro l'HTML finalizzato.
 *
 * Input:
 *   {
 *     html: string,           // HTML gia' passato per finalizeSwipe
 *     texts: Array<{id, original, tag, position, _bundleUrl?}>,
 *     rewrites: Array<{id, rewritten}>,
 *   }
 *
 * Logica:
 *   1. raggruppa rewrite per _bundleUrl (solo texts con tag='js-bundle')
 *   2. per ogni bundle: fetch, apply replacements, inline
 *
 * Ritorna: { html, stats }
 */
async function inlineBundleRewrites({ html, texts, rewrites }, { log = () => {}, warn = () => {} } = {}) {
  const stats = {
    bundlesAttempted: 0,
    bundlesInlined: 0,
    bundlesFailed: 0,
    totalReplacements: 0,
    errors: [],
  };
  if (!html || typeof html !== 'string') return { html: html || '', stats };
  if (!Array.isArray(texts) || !Array.isArray(rewrites)) return { html, stats };

  const idToRewrite = new Map();
  for (const r of rewrites) {
    if (typeof r.id !== 'number' || typeof r.rewritten !== 'string') continue;
    idToRewrite.set(r.id, r.rewritten);
  }

  // Group: bundleUrl -> [{orig, rewr}]
  const byBundle = new Map();
  for (const t of texts) {
    if (!t || t.tag !== 'js-bundle') continue;
    const url = t._bundleUrl;
    if (!url) continue;
    const rewr = idToRewrite.get(t.id);
    if (!rewr || rewr === t.original) continue;
    if (!byBundle.has(url)) byBundle.set(url, []);
    byBundle.get(url).push({ orig: t.original, rewr });
  }

  if (byBundle.size === 0) return { html, stats };

  log(`  · bundle-inliner: ${byBundle.size} bundle da modificare, ${[...byBundle.values()].reduce((a, b) => a + b.length, 0)} rewrite totali`);

  let workingHtml = html;
  for (const [bundleUrl, replacements] of byBundle) {
    stats.bundlesAttempted++;
    const fetched = await fetchBundleSafe(bundleUrl);
    if (!fetched.ok) {
      stats.bundlesFailed++;
      stats.errors.push(`fetch ${bundleUrl}: ${fetched.status}${fetched.error ? ` (${fetched.error})` : ''}`);
      warn(`    ⚠️  bundle ${bundleUrl} fetch fallita: ${fetched.status}`);
      continue;
    }
    const { js: modifiedJs, applied } = applyReplacementsToBundle(fetched.body, replacements);
    if (applied === 0) {
      stats.bundlesFailed++;
      stats.errors.push(`bundle ${bundleUrl}: 0/${replacements.length} stringhe applicate (forse gia' minificate diversamente)`);
      warn(`    ⚠️  bundle ${bundleUrl}: 0/${replacements.length} replace applicati`);
      continue;
    }
    const inlined = inlineBundleInHtml(workingHtml, bundleUrl, modifiedJs);
    if (!inlined.replaced) {
      stats.bundlesFailed++;
      stats.errors.push(`bundle ${bundleUrl}: <script src> non trovato nell'HTML finalizzato`);
      warn(`    ⚠️  bundle ${bundleUrl}: tag <script src> non trovato`);
      continue;
    }
    workingHtml = inlined.html;
    stats.bundlesInlined++;
    stats.totalReplacements += applied;
    log(`    ✓ bundle ${bundleUrl.split('/').pop()} inlined: ${applied}/${replacements.length} stringhe applicate`);
  }
  log(`  · bundle-inliner: completato — ${stats.bundlesInlined}/${stats.bundlesAttempted} bundle inlined, ${stats.totalReplacements} stringhe riscritte`);
  return { html: workingHtml, stats };
}

module.exports = {
  inlineBundleRewrites,
  applyReplacementsToBundle,
  inlineBundleInHtml,
};
