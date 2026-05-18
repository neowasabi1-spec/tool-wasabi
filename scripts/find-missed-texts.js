// scripts/find-missed-texts.js
//
// Trova ESATTAMENTE dove nell'HTML rewritten stanno ancora le occorrenze
// dei facts del competitor. Stampa il contesto (tag + 100 char prima/dopo)
// cosi capiamo PERCHE l'extractor non li ha catturati.
const fs = require('fs');
const path = require('path');

const htmlPath = process.argv[2] || (() => {
  // Trova l'ultimo swipe-result-*.html in TEMP
  const tmp = process.env.TEMP || '/tmp';
  const files = fs.readdirSync(tmp).filter((f) => f.startsWith('swipe-result-') && f.endsWith('.html'));
  if (files.length === 0) throw new Error('Nessun swipe-result-*.html in ' + tmp);
  files.sort((a, b) => fs.statSync(path.join(tmp, b)).mtimeMs - fs.statSync(path.join(tmp, a)).mtimeMs);
  return path.join(tmp, files[0]);
})();

console.log('Analizzo: ' + htmlPath);
const rawHtml = fs.readFileSync(htmlPath, 'utf8');
console.log('Size raw: ' + rawHtml.length + ' chars');

// STRIP del mapping JSON iniettato dal worker (es. window.__SWIPE_MAPPING__ = [...])
// che contiene tutte le coppie {from, to}. Senza strippare, ogni "from"
// del competitor appare come "ancora presente" ma e' solo la mappa di
// riscrittura, NON il copy visibile della pagina.
let html = rawHtml;
// Pattern 1: variabile window.__SWIPE_*__ = [...]
html = html.replace(/window\.__SWIPE_[A-Z_]+__\s*=\s*[\s\S]*?;\s*<\/script>/gi, '<!--swipe-mapping-stripped--></script>');
// Pattern 2: array di {"from":"...","to":"..."} ovunque nello script
html = html.replace(/\[\s*(\{\s*"from"\s*:[\s\S]*?\}\s*,?\s*){2,}\]/g, '[/*swipe-mapping-stripped*/]');
console.log('Size senza mapping JSON: ' + html.length + ' chars (rimossi ' + (rawHtml.length - html.length) + ' char di mapping)\n');

const FACTS_TO_FIND = [
  'Jeremy Campbell',
  'Dr. Campbell',
  'Chicago',
  '15 minutes',
  '1100 patients',
  '4,000 5-star',
  'plantar fasciitis',
  'overpronation',
  'NMES Foot Massager',
  'tibialis posterior',
];

for (const fact of FACTS_TO_FIND) {
  console.log('=====================================================');
  console.log('FACT: "' + fact + '"');
  console.log('=====================================================');
  const re = new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let match;
  let count = 0;
  while ((match = re.exec(html)) !== null && count < 5) {
    const start = Math.max(0, match.index - 150);
    const end = Math.min(html.length, match.index + match[0].length + 150);
    const context = html.substring(start, end).replace(/\s+/g, ' ');
    console.log('  Match #' + (count + 1) + ' at offset ' + match.index + ':');
    console.log('    ...' + context + '...');
    console.log('');
    count++;
  }
  if (count === 0) console.log('  (zero match — facts gia sostituito)\n');
}

// Bonus: cerchiamo iframe, svg, data-* attributi pieni di testo
console.log('=====================================================');
console.log('CONTESTI SOSPETTI (iframe, svg text, content CSS, ...)');
console.log('=====================================================');
const iframes = (html.match(/<iframe[^>]*src="([^"]+)"/gi) || []).length;
const svgTexts = (html.match(/<svg[\s\S]*?<\/svg>/gi) || []).length;
const contentCss = (html.match(/content:\s*['"][^'"]+['"]/gi) || []).length;
const altAttrs = (html.match(/\salt="[^"]{20,}"/gi) || []).length;
console.log('  iframe count: ' + iframes);
console.log('  inline svg count: ' + svgTexts);
console.log('  CSS content: rules: ' + contentCss);
console.log('  alt attrs > 20 char: ' + altAttrs);
