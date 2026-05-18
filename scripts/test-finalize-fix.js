// scripts/test-finalize-fix.js
//
// End-to-end test: ricarica l'HTML originale di Nooro review-95 +
// i 230 pair {from,to} estratti dal mapping iniettato nell'ultimo
// response. Esegue finalizeSwipe col fix nuovo e verifica che
// "overpronation" sparisca dal copy visibile (escludendo il mapping).
const fs = require('fs');
const path = require('path');
const { finalizeSwipe } = require('../worker-lib/finalize.js');

const tmp = process.env.TEMP || '/tmp';
const origHtml = fs.readFileSync(path.join(tmp, 'nooro-review-95.html'), 'utf8');
const responseHtml = fs.readFileSync(path.join(tmp, 'swipe-result-22affe6b.html'), 'utf8');

// Estrai i pair {from, to} dal mapping iniettato
const re = /\{\s*"from"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"to"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const pairs = [];
let m;
while ((m = re.exec(responseHtml)) !== null) {
  // Deserializza le escape JSON
  try {
    const from = JSON.parse('"' + m[1] + '"');
    const to = JSON.parse('"' + m[2] + '"');
    pairs.push({ from, to });
  } catch {}
}
console.log('Pair estratti dal mapping del response: ' + pairs.length);

// Costruisci texts[] e rewrites[]. Usiamo tag='div' default (poi finalize
// fa replacementPairs.sort length desc, quindi l'ordine non conta).
const texts = pairs.map((p, i) => ({ id: i, original: p.from, tag: 'div', position: i }));
const rewrites = pairs.map((p, i) => ({ id: i, rewritten: p.to }));

console.log('Eseguo finalizeSwipe con il fix nuovo...\n');
const result = finalizeSwipe({
  html: origHtml,
  sourceUrl: 'https://try.nooro-us.com/review-95',
  texts,
  rewrites,
  productName: 'Metabolic Wave',
});

console.log('=== RISULTATO ===');
console.log('  totalTexts: ' + result.totalTexts);
console.log('  replacements: ' + result.replacements);
console.log('  server_side_html: ' + result.replacements_server_side_html);
console.log('  server_side_fuzzy: ' + result.replacements_server_side_fuzzy);
console.log('  unresolved: ' + (result.unresolved_text_ids?.length || 0));
console.log('  HTML output: ' + result.html.length + ' chars');

// Strip mapping JSON per cercare solo nel copy visibile
let cleanedHtml = result.html;
cleanedHtml = cleanedHtml.replace(/window\.__SWIPE_[A-Z_]+__\s*=\s*[\s\S]*?;\s*<\/script>/gi, '');
cleanedHtml = cleanedHtml.replace(/\[\s*(\{\s*"from"\s*:[\s\S]*?\}\s*,?\s*){2,}\]/g, '');

// Cerca facts del competitor che dovrebbero essere spariti
const checks = [
  'Jeremy Campbell',
  'Dr. Campbell',
  'Chicago',
  '15 minutes',
  '1100 patients',
  'NMES Foot Massager',
  'tibialis posterior',
  'overpronation',
  'plantar fasciitis',
  'Charlotte Hudson',
  'William Boxall',
];
console.log('\n=== Facts COMPETITOR ancora presenti nel copy VISIBILE (no mapping) ===');
let stillPresent = 0;
for (const fact of checks) {
  const re2 = new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const count = (cleanedHtml.match(re2) || []).length;
  if (count > 0) {
    console.log('  X  ' + fact.padEnd(28) + ' presente ' + count + ' volte');
    stillPresent++;
  } else {
    console.log('  OK ' + fact.padEnd(28) + ' RIMOSSO');
  }
}
console.log('\nFacts competitor ancora presenti: ' + stillPresent + '/' + checks.length);

// Salva l'output per ispezione manuale
const outPath = path.join(tmp, 'finalize-fix-output.html');
fs.writeFileSync(outPath, result.html);
console.log('\nHTML risultato salvato in: ' + outPath);
