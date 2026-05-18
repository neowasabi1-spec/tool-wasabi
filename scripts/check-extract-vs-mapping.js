// scripts/check-extract-vs-mapping.js
//
// L'extractor SU REVIEW-95 estrae il testo lungo "Achilles Tendinitis:
// Overpronation can cause..."? Se sì ma non e' nel mapping, allora viene
// droppato dal dedupe / cap / build-prompts.
const fs = require('fs');
const path = require('path');
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor.js');
const { buildPrompts } = require('../worker-lib/build-prompts.js');

const tmp = process.env.TEMP || '/tmp';
const html = fs.readFileSync(path.join(tmp, 'nooro-review-95.html'), 'utf8');

console.log('=== STEP A: cosa estrae extractAllTextsUniversal? ===');
const raw = extractAllTextsUniversal(html);
const achillesRaw = raw.filter((t) => /Achilles.*Overpronation/i.test(t.text) || /Overpronation can cause/i.test(t.text));
console.log('  ' + achillesRaw.length + ' testi raw matchano Achilles/Overpronation:');
achillesRaw.forEach((t, i) => console.log('    ' + (i + 1) + '. [' + t.context + '] (len=' + t.text.length + ') ' + t.text.substring(0, 120)));

console.log('\n=== STEP B: cosa passa a buildPrompts (post filtri/dedupe/cap)? ===');
const result = buildPrompts({
  html,
  sourceUrl: 'https://try.nooro-us.com/review-95',
  product: { name: 'Metabolic Wave' },
  language: 'en',
  knowledge: { prompts: [], brief: '', marketResearch: '' },
});
console.log('  texts: ' + result.texts.length);
const achillesFinal = result.texts.filter((t) => /Achilles.*Overpronation/i.test(t.original) || /Overpronation can cause/i.test(t.original) || /Toe Deformities.*Overpronation/i.test(t.original) || /Lower Back Pain.*Overpronation/i.test(t.original) || /Varicose.*overpronation/i.test(t.original));
console.log('  ' + achillesFinal.length + ' testi FINALI matchano bullet point:');
achillesFinal.forEach((t, i) => console.log('    ' + (i + 1) + '. [' + t.tag + '] (len=' + t.original.length + ') ' + t.original.substring(0, 150)));

console.log('\n=== STEP C: testi LUNGHI estratti (>100 char) ===');
const longTexts = result.texts.filter((t) => t.original.length > 200);
console.log('  ' + longTexts.length + ' testi > 200 char');
longTexts.slice(0, 15).forEach((t, i) => {
  console.log('    ' + (i + 1) + '. [' + t.tag + '] (len=' + t.original.length + ') ' + t.original.substring(0, 120));
});

console.log('\n=== STEP D: c\'e\' un testo che contiene "overpronation" che PASSA i filtri? ===');
const containsOver = result.texts.filter((t) => /overpronation/i.test(t.original));
console.log('  ' + containsOver.length + ' testi con "overpronation":');
containsOver.forEach((t, i) => console.log('    ' + (i + 1) + '. [' + t.tag + '] (len=' + t.original.length + ') ' + t.original.substring(0, 200)));
