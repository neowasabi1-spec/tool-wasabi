// scripts/test-extract-deep-nooro.js
//
// Analisi DEEP: capiamo dove stanno i ~70 testi tra raw extraction (413)
// e final rewrite list (232). Vediamo se sono dedupe legittimi (testo
// uguale in piu' posti) o se stiamo droppando copy reale.
const fs = require('fs');
const path = require('path');
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor.js');

const htmlPath = process.env.HTML_PATH
  || path.join(process.env.TEMP || '/tmp', 'nooro-review-95.html');

if (!fs.existsSync(htmlPath)) {
  console.error('HTML non trovato in ' + htmlPath);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const raw = extractAllTextsUniversal(html);
console.log('Step 0: estratti raw (con dedupe per text+context): ' + raw.length);

const SAFE_TAG_CONTEXT = new Set(['title', 'meta:content', 'noscript', 'js-bundle']);
const SAFE = ['tag:h1','tag:h2','tag:h3','tag:h4','tag:h5','tag:h6','tag:p','tag:li','tag:td','tag:th','tag:dt','tag:dd','tag:button','tag:a','tag:label','tag:figcaption','tag:blockquote','tag:summary','tag:legend','tag:option','tag:span','tag:strong','tag:em','tag:b','tag:i','tag:u','tag:small','tag:mark','tag:cite','tag:q','tag:abbr','tag:div','mixed:p','mixed:div','mixed:li','mixed:td','mixed:th','mixed:h1','mixed:h2','mixed:h3','mixed:h4','mixed:h5','mixed:h6','mixed:span','mixed:strong','mixed:em','mixed:a','mixed:b','mixed:i','mixed:button','mixed:header','mixed:footer','mixed:section','mixed:article','mixed:nav','mixed:aside','mixed:main','mixed:figcaption','mixed:caption','mixed:summary','mixed:label','mixed:blockquote','mixed:dt','mixed:dd','attr:alt','attr:title','attr:placeholder','attr:aria-label','attr:value','spa-json:','json-ld:','meta:'];

function isSafe(ctx) {
  if (SAFE_TAG_CONTEXT.has(ctx)) return true;
  return SAFE.some((p) => ctx === p || ctx.startsWith(p + ':') || (p.endsWith(':') && ctx.startsWith(p)));
}

// Conta perche' vengono droppati
const droppedReasons = { unsafe: 0, tooShort: 0, tooLong: 0, noLetter: 0, urlLike: 0, codeLike: 0 };
const droppedSamples = { unsafe: [], tooShort: [], tooLong: [], noLetter: [], urlLike: [], codeLike: [] };
const passed = [];

for (const u of raw) {
  if (!isSafe(u.context)) {
    droppedReasons.unsafe++;
    if (droppedSamples.unsafe.length < 8) droppedSamples.unsafe.push({ ctx: u.context, t: u.text.substring(0, 80) });
    continue;
  }
  if (u.text.length < 2) { droppedReasons.tooShort++; if (droppedSamples.tooShort.length < 5) droppedSamples.tooShort.push({ ctx: u.context, t: u.text }); continue; }
  if (u.text.length > 4000) { droppedReasons.tooLong++; if (droppedSamples.tooLong.length < 5) droppedSamples.tooLong.push({ ctx: u.context, t: u.text.substring(0, 100) + '...' }); continue; }
  if (!/[a-zA-Z]/.test(u.text)) { droppedReasons.noLetter++; if (droppedSamples.noLetter.length < 5) droppedSamples.noLetter.push({ ctx: u.context, t: u.text }); continue; }
  if (u.text.startsWith('http://') || u.text.startsWith('https://')) { droppedReasons.urlLike++; if (droppedSamples.urlLike.length < 5) droppedSamples.urlLike.push({ ctx: u.context, t: u.text.substring(0, 80) }); continue; }
  if (u.text.includes('{') && u.text.includes('}') && /[=:]\s*function|=>/.test(u.text)) { droppedReasons.codeLike++; if (droppedSamples.codeLike.length < 5) droppedSamples.codeLike.push({ ctx: u.context, t: u.text.substring(0, 80) }); continue; }
  passed.push(u);
}

console.log('Step 1: passano i filtri di sicurezza: ' + passed.length);
console.log('  droppati per context unsafe: ' + droppedReasons.unsafe);
console.log('  droppati per text < 2: ' + droppedReasons.tooShort);
console.log('  droppati per text > 800: ' + droppedReasons.tooLong);
console.log('  droppati per no-letter: ' + droppedReasons.noLetter);
console.log('  droppati per url-like: ' + droppedReasons.urlLike);
console.log('  droppati per code-like: ' + droppedReasons.codeLike);

// Dedupe per text (la pipeline fa questo a build-prompts.js riga 94)
const uniqueByText = new Map();
for (const u of passed) {
  if (!uniqueByText.has(u.text)) uniqueByText.set(u.text, u);
}
console.log('Step 2: unique per testo (dopo dedupe): ' + uniqueByText.size);

const dups = passed.length - uniqueByText.size;
console.log('  dedupe ha rimosso: ' + dups + ' duplicati (stesso testo in piu' + "'" + ' punti — replacements futuri li copriranno tutti)');

console.log('\n=== Sample testi DROPPATI per context unsafe (potenziale copy perso) ===');
droppedSamples.unsafe.forEach((s, i) => console.log('  ' + (i + 1) + '. [' + s.ctx + '] ' + s.t));

console.log('\n=== Sample testi DROPPATI per length > 800 (potenziale copy lungo perso) ===');
droppedSamples.tooLong.forEach((s, i) => console.log('  ' + (i + 1) + '. [' + s.ctx + '] ' + s.t));

console.log('\n=== Top 10 testi DUPLICATI (saranno 1 rewrite ma N replacements) ===');
const dupCounter = new Map();
for (const u of passed) {
  dupCounter.set(u.text, (dupCounter.get(u.text) || 0) + 1);
}
const topDup = Array.from(dupCounter.entries()).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
topDup.forEach(([txt, n], i) => console.log('  ' + (i + 1) + '. (x' + n + ') ' + txt.substring(0, 80)));
