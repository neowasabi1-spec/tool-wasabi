// scripts/test-extract-nooro.js
// Test diagnostico: quanti testi vengono persi a causa del filtro
// isSafeContext attuale che NON include 'tag:div'. Da eseguire con
// `node scripts/test-extract-nooro.js`.
const fs = require('fs');
const path = require('path');
const { extractAllTextsUniversal } = require('../worker-lib/text-extractor.js');

const htmlPath = process.env.HTML_PATH
  || path.join(process.env.TEMP || '/tmp', 'nooro-review-95.html');

if (!fs.existsSync(htmlPath)) {
  console.error('HTML non trovato in ' + htmlPath);
  console.error('Scaricalo con: Invoke-WebRequest -Uri "..." -OutFile $htmlPath');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const texts = extractAllTextsUniversal(html);
console.log('Total extracted: ' + texts.length);

const SAFE_TAG_CONTEXT = new Set(['title', 'meta:content', 'noscript', 'js-bundle']);
const SAFE_OLD = ['tag:h1','tag:h2','tag:h3','tag:h4','tag:h5','tag:h6','tag:p','tag:li','tag:td','tag:th','tag:dt','tag:dd','tag:button','tag:a','tag:label','tag:figcaption','tag:blockquote','tag:summary','tag:legend','tag:option','tag:span','tag:strong','tag:em','tag:b','tag:i','tag:u','tag:small','tag:mark','tag:cite','tag:q','tag:abbr','mixed:p','mixed:div','mixed:li','mixed:td','mixed:th','mixed:h1','mixed:h2','mixed:h3','mixed:h4','mixed:h5','mixed:h6','mixed:span','mixed:strong','mixed:em','mixed:a','mixed:b','mixed:i','mixed:button','mixed:header','mixed:footer','mixed:section','mixed:article','mixed:nav','mixed:aside','mixed:main','mixed:figcaption','mixed:caption','mixed:summary','mixed:label','mixed:blockquote','mixed:dt','mixed:dd','attr:alt','attr:title','attr:placeholder','attr:aria-label','attr:value','spa-json:','json-ld:','meta:'];

function isSafe(ctx, list) {
  if (SAFE_TAG_CONTEXT.has(ctx)) return true;
  return list.some((p) => ctx === p || ctx.startsWith(p + ':') || (p.endsWith(':') && ctx.startsWith(p)));
}

function passFilters(t, list) {
  if (!isSafe(t.context, list)) return false;
  if (t.text.length < 2 || t.text.length > 4000) return false;
  if (!/[a-zA-Z]/.test(t.text)) return false;
  if (t.text.startsWith('http://') || t.text.startsWith('https://')) return false;
  if (t.text.includes('{') && t.text.includes('}') && /[=:]\s*function|=>/.test(t.text)) return false;
  return true;
}

const passOld = texts.filter((t) => passFilters(t, SAFE_OLD));
console.log('SENZA tag:div in safe list (status attuale): ' + passOld.length + ' testi al rewrite');

const SAFE_NEW = [...SAFE_OLD, 'tag:div'];
const passNew = texts.filter((t) => passFilters(t, SAFE_NEW));
console.log('CON tag:div in safe list: ' + passNew.length + ' testi al rewrite');

console.log('');
console.log('Delta: +' + (passNew.length - passOld.length) + ' testi recuperati');
console.log('');

// Mostra i primi 30 testi tag:div che oggi vengono PERSI
const lostNow = texts.filter((t) => t.context === 'tag:div' && passFilters(t, SAFE_NEW));
console.log('Esempi di testi tag:div oggi PERSI (mostro primi 30):');
lostNow.slice(0, 30).forEach((t, i) => {
  const preview = t.text.length > 120 ? t.text.substring(0, 117) + '...' : t.text;
  console.log('  ' + (i + 1).toString().padStart(2, ' ') + '. ' + preview);
});
