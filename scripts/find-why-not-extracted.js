// scripts/find-why-not-extracted.js
//
// Cerca i 5 frammenti "Overpronation can ..." nell'HTML ORIGINALE
// (pre-rewrite) e mostra il contesto HTML completo intorno, cosi
// capiamo perche' l'extractor non li ha catturati.
const fs = require('fs');
const path = require('path');
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor.js');

const htmlPath = process.env.HTML_PATH
  || path.join(process.env.TEMP || '/tmp', 'nooro-review-95.html');

const html = fs.readFileSync(htmlPath, 'utf8');
console.log('HTML originale: ' + html.length + ' chars\n');

// Estrai TUTTO con il nostro extractor aggiornato
const texts = extractAllTextsUniversal(html);
console.log('Extractor estrae: ' + texts.length + ' testi\n');

// Cerca testi residui originali nell'HTML originale
const fragmentsToFind = [
  'Overpronation can cause the Achilles tendon',
  'Overpronation can change your posture',
  'Overpronation can lead to increased pressure',
  'caused by overpronation can impact circulation',
  'to correct overpronation and relieve',
];

for (const fragment of fragmentsToFind) {
  console.log('═══════════════════════════════════════');
  console.log('FRAGMENT: "' + fragment + '"');
  console.log('═══════════════════════════════════════');

  // 1) Esiste nell'HTML originale?
  const idx = html.indexOf(fragment);
  if (idx === -1) {
    console.log('  NON ESISTE nell HTML originale!');
    continue;
  }
  console.log('  Posizione HTML: offset ' + idx);

  // 2) Mostra contesto HTML PRIMA e DOPO (300 char)
  const start = Math.max(0, idx - 300);
  const end = Math.min(html.length, idx + fragment.length + 300);
  console.log('  Contesto HTML originale (300 char prima/dopo):');
  console.log('  ---');
  console.log(html.substring(start, end));
  console.log('  ---');

  // 3) L'extractor ha catturato un testo che CONTIENE questo fragment?
  const matchingExtracted = texts.filter((t) => t.text.includes(fragment));
  console.log('  Testi estratti che contengono questo fragment: ' + matchingExtracted.length);
  matchingExtracted.forEach((t) => {
    console.log('    [' + t.context + '] ' + t.text.substring(0, 150) + (t.text.length > 150 ? '...' : ''));
  });
  console.log('');
}
