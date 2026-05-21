// Sanity test del filtro looksLikeTechnicalBoilerplate.
// Eseguire con: node scripts/test-boilerplate-filter.js
const path = require('path');

// Re-implementazione dei pattern (devono restare allineati a
// worker-lib/text-extractor.js — se uno cambia, aggiornare anche
// l'altro).
const META_TECHNICAL_RE = /^[a-zA-Z\-]+\s*=\s*[^,\s]+(?:\s*,\s*[a-zA-Z\-]+\s*=\s*[^,\s]+){0,4}$/;
const URL_PATH_RE = /^\/[A-Za-z0-9_\-/.~%]+$/;
const HASH_RE = /^[A-Za-z0-9_\-]{24,}$/;
const CSS_TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9]*(?:[-_]+[a-zA-Z0-9]+){1,8}$/;
const CSV_TECHNICAL_TOKENS_RE = /^[a-z][a-z0-9\-]{1,30}(?:\s*[,;]\s*[a-z][a-z0-9\-]{1,30}){1,8}$/;

function looksLikeTechnicalBoilerplate(s) {
  if (!s) return false;
  const len = s.length;
  if (len < 3) return false;
  if (URL_PATH_RE.test(s)) return true;
  if (HASH_RE.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s)) return true;
  if (META_TECHNICAL_RE.test(s) && /[a-zA-Z][a-zA-Z\-]*=/.test(s)) return true;
  if (CSV_TECHNICAL_TOKENS_RE.test(s)) return true;
  if (
    len >= 4 && len <= 50 &&
    !/\s/.test(s) &&
    !/[.!?:;,'"()[\]{}—–]/.test(s) &&
    CSS_TOKEN_RE.test(s)
  ) return true;
  return false;
}

const SHOULD_FILTER = [
  // Da log salvinilabs/adv9 (i veri colpevoli del thrashing)
  'width=device-width,initial-scale=1',
  '/96283164998/digital_wallets/dialog',
  '4e5323e83f88dbf4747a395309921945',
  // Pattern equivalenti che vediamo spesso
  'IE=edge',
  '/checkout/contact_information',
  'shopify-section-header',
  'cart_drawer_open',
  'btn-primary--large',
  'no-cache,no-store',
  'shop_pay_session_abc123def456ghi789',
];

const SHOULD_PASS = [
  // Copy reale che NON deve essere filtrato (regressione check)
  'Get yours now — Just $39',
  'Ihr Warenkorb ist leer',
  'Your cart is empty',
  'Warenkorb • 0 Artikel',
  'Cart • 0 items',
  'Metabolic Wave',
  'Dr. Alan Reed',
  'Add to cart',
  'Buy now',
  '90-day money-back guarantee',
  'Lose 20 lbs in 90 days',
  'WAS $79',
  'NOW $39',
  '"GLP-1 Reactivation" breakthrough',
  // Single word copy (passa per via di < 3 char OR mancanza di token-pattern)
  'Hi',
  'OK',
  'Yes',
  // Nomi propri / brand
  'Ozempic',
  'Apple Pay',
  // Numeri / prezzi
  '$39',
  '€1.200',
  '20 lbs',
];

let failed = 0;
console.log('--- DEVE FILTRARE (boilerplate) ---');
for (const s of SHOULD_FILTER) {
  const got = looksLikeTechnicalBoilerplate(s);
  const ok = got === true;
  if (!ok) failed++;
  console.log(`  [${ok ? '\u2713' : '\u2717'}] ${JSON.stringify(s)} → ${got}`);
}

console.log('\n--- NON deve filtrare (copy reale) ---');
for (const s of SHOULD_PASS) {
  const got = looksLikeTechnicalBoilerplate(s);
  const ok = got === false;
  if (!ok) failed++;
  console.log(`  [${ok ? '\u2713' : '\u2717'}] ${JSON.stringify(s)} → ${got}`);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${failed} test falliti`);
process.exit(failed === 0 ? 0 : 1);
