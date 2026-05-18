// scripts/find-overpronation-pairs.js
//
// Trova tutti i pair {from, to} nel mapping iniettato che hanno
// "overpronation" nel from, e tutti i pair che hanno "overpronation"
// nel to. Cosi capiamo se NEO ha tradotto la parola.
const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2] || (() => {
  const tmp = process.env.TEMP || '/tmp';
  const files = fs.readdirSync(tmp).filter((f) => f.startsWith('swipe-result-') && f.endsWith('.html'));
  if (!files.length) throw new Error('no swipe-result-*.html');
  files.sort((a, b) => fs.statSync(path.join(tmp, b)).mtimeMs - fs.statSync(path.join(tmp, a)).mtimeMs);
  return path.join(tmp, files[0]);
})();

const html = fs.readFileSync(htmlPath, 'utf8');

const re = /\{\s*"from"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"to"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
let m;
let totalPairs = 0;
let fromHasOver = [];
let toHasOver = [];
while ((m = re.exec(html)) !== null) {
  totalPairs++;
  const from = m[1];
  const to = m[2];
  if (/overpronation/i.test(from)) fromHasOver.push({ from, to });
  if (/overpronation/i.test(to)) toHasOver.push({ from, to });
}
console.log('Totale pair nel mapping: ' + totalPairs);
console.log('');
console.log('=== Pair che hanno "overpronation" nel FROM (testo originale) ===');
fromHasOver.forEach((p, i) => {
  console.log((i + 1) + '. FROM: ' + p.from.substring(0, 250));
  console.log('   TO:   ' + p.to.substring(0, 250));
  console.log('');
});
console.log('Totale: ' + fromHasOver.length);
console.log('');
console.log('=== Pair che hanno "overpronation" nel TO (testo riscritto) ===');
toHasOver.forEach((p, i) => {
  console.log((i + 1) + '. FROM: ' + p.from.substring(0, 250));
  console.log('   TO:   ' + p.to.substring(0, 250));
  console.log('');
});
console.log('Totale: ' + toHasOver.length);
