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
const CSS_RULE_RE = /\{[^{}]*:[^{}]*\}/;
const CSS_INDICATOR_RE = /\b(?:padding-(?:top|bottom|left|right)|margin-(?:top|bottom|left|right)|color-scheme|--color-[a-z\-]+|--gradient-[a-z\-]+|font-(?:size|family|weight|style)|line-height|background(?:-color|-image)?|display\s*:|width\s*:|height\s*:|@media\s+(?:screen|all|print)|nth-child|grid-template|flex-direction|column-gap|row-gap|var\s*\(\s*--)/;

function looksLikeTechnicalBoilerplate(s) {
  if (!s) return false;
  const len = s.length;
  if (len < 3) return false;
  if (URL_PATH_RE.test(s)) return true;
  if (HASH_RE.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s)) return true;
  if (META_TECHNICAL_RE.test(s) && /[a-zA-Z][a-zA-Z\-]*=/.test(s)) return true;
  if (CSV_TECHNICAL_TOKENS_RE.test(s)) return true;
  if (len >= 30 && CSS_RULE_RE.test(s) && CSS_INDICATOR_RE.test(s)) return true;
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
  // Da log calminity (Shopify section CSS)
  '.icon-hamburger { display: flex !important; align-items: flex-start; flex-direction: column; gap: calc(8px - var(--icons-thickness)); }',
  '.section-template--29442616754517__custom_columns_KDUTnD-padding { padding-top: 12px; padding-bottom: 12px; }',
  '.color-scheme-template--29442616754517__rich_text_ajjPdP.color-custom { --color-background: 255, 255, 255; --gradient-background: #ffffff; --color-foreground: 46, 42, 57; }',
  '.drawer { visibility: hidden; } .cart-drawer .drawer__footer { background: #f3f3f3; }',
  '.cart-drawer .cart-item--product-shipping-insurance { display: none; }',
  '@media screen and (min-width: 750px) { .header { padding-top: 16px; padding-bottom: 20px; } }',
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
  // Copy con braces / colon che NON è CSS (regressione check)
  'Email: support@brand.com — risposta entro 24h',
  'Bonus: free shipping on orders over $50',
  'Step 1: choose your plan. Step 2: complete checkout.',
  'Use code {SAVE20} at checkout for 20% off your order',
  'Limited time: 50% off our best-selling formula',
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
