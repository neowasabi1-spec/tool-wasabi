// Verification for TASK §3.1 + §3.2.
// Transpiles src/lib/checkout-modes.ts with the project's own TypeScript
// compiler, so what we test is exactly what ships — no hand-edited copy.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/denys/tool-wasabi/package.json');
const ts = require('typescript');

const SRC = '/home/denys/tool-wasabi/src/lib/checkout-modes.ts';
const raw = readFileSync(SRC, 'utf8');

const js = ts.transpileModule(raw, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

const {
  normalizeCheckoutMode,
  withCheckoutRules,
  checkoutPromptAddendum,
  isCheckoutPageType,
  WASABI_CHECKOUT_RULES,
  DEFAULT_CHECKOUT_MODE,
  CHECKOUT_MODE_OPTIONS,
} = mod;

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
};

const BASE = 'ORIGINAL SYSTEM PROMPT\nline two\nline three';

console.log('\n=== §3.1  normalizeCheckoutMode + withCheckoutRules ===');
console.log(`base system prompt = ${BASE.length} bytes\n`);
console.log('input'.padEnd(14) + 'normalized'.padEnd(12) + 'prompt bytes'.padEnd(14) + 'byte-identical to base?');
console.log('-'.repeat(70));

const cases = [
  ['undefined', undefined],
  ['null', null],
  ["''", ''],
  ["'standard'", 'standard'],
  ["'STANDARD'", 'STANDARD'],
  ["'nonsense'", 'nonsense'],
  ["'wasabi'", 'wasabi'],
  ["'WASABI'", 'WASABI'],
  ["' Wasabi '", ' Wasabi '],
];

for (const [label, input] of cases) {
  const norm = normalizeCheckoutMode(input);
  const out = withCheckoutRules(BASE, input);
  const identical = out === BASE;
  console.log(
    label.padEnd(14) + norm.padEnd(12) + String(out.length).padEnd(14) + (identical ? 'YES' : `no (+${out.length - BASE.length})`),
  );
  const shouldBeWasabi = /^\s*wasabi\s*$/i.test(String(input ?? ''));
  ok(norm === (shouldBeWasabi ? 'wasabi' : 'standard'), `${label} → ${norm}`);
  ok(identical === !shouldBeWasabi, `${label} prompt ${shouldBeWasabi ? 'modified' : 'BYTE-IDENTICAL'}`);
}

console.log('\n-- every non-wasabi input leaves the prompt byte-identical --');
const nonWasabi = cases.filter(([, v]) => !/^\s*wasabi\s*$/i.test(String(v ?? '')));
ok(
  nonWasabi.every(([, v]) => withCheckoutRules(BASE, v) === BASE),
  `all ${nonWasabi.length} non-wasabi inputs → prompt unchanged, byte for byte`,
);
ok(nonWasabi.every(([, v]) => checkoutPromptAddendum(v) === ''), 'checkoutPromptAddendum() === "" for all non-wasabi inputs');
ok(DEFAULT_CHECKOUT_MODE === 'standard', "DEFAULT_CHECKOUT_MODE === 'standard'");
ok(withCheckoutRules(BASE, 'wasabi') === `${BASE}\n\n${WASABI_CHECKOUT_RULES}`, 'wasabi → base + "\\n\\n" + rules');

console.log('\n=== isCheckoutPageType (leak guard) ===');
for (const t of ['checkout', 'order_form', 'checkout_page', 'orderform', 'order']) {
  ok(isCheckoutPageType(t) === true, `'${t}' → checkout`);
}
for (const t of ['landing', 'advertorial', 'quiz_funnel', 'upsell', 'thank_you', '', null, undefined]) {
  ok(isCheckoutPageType(t) === false, `${JSON.stringify(t)} → NOT checkout`);
}

console.log('\n=== §3.2  key strings survive in the rules constant ===');
// Anchors of the SOURCE-DERIVED contract (v2 of this ruleset). The old
// Appendix A wording was replaced: it described the checkout as a
// self-contained document, which is what broke a live page.
const required = [
  'data-wc-payment',
  'data-wc-submit',
  'wasabi-checkout.js',
  'data-wc-option-item',
  'data-wc-when',
  'option.total',
  // the facts whose absence caused the production failure
  'fragment',
  'same-origin relative',
  'renderCheckoutPage',
  'data-wc-step-next',
  '<base>',
  'data-wc-field',
];
for (const s of required) {
  ok(WASABI_CHECKOUT_RULES.includes(s), `contains ${JSON.stringify(s)}`);
}

console.log('\n=== §2.1  the placeholder trailer must NEVER reach the model ===');
ok(!WASABI_CHECKOUT_RULES.includes('describe your change here'), 'no "describe your change here"');
ok(!WASABI_CHECKOUT_RULES.includes('## What I want changed'), 'no "## What I want changed"');

console.log('\n=== regressions the old ruleset caused (must not come back) ===');
ok(
  !/HTML contains NO payment logic/.test(WASABI_CHECKOUT_RULES),
  'no longer claims the HTML is self-contained (that claim broke a live checkout)',
);
ok(
  !/NEVER add, remove, edit or reorder any/.test(WASABI_CHECKOUT_RULES),
  'no "never remove a script" phrasing (read as licence to ADD one when generating)',
);
ok(
  /fragment/i.test(WASABI_CHECKOUT_RULES) && /origin/i.test(WASABI_CHECKOUT_RULES),
  'states the page is a fragment served from the CRM origin',
);
ok(
  WASABI_CHECKOUT_RULES.startsWith('=== WASABICRM CHECKOUT — BINDING RULES ==='),
  'wrapped with the required header',
);
ok(
  WASABI_CHECKOUT_RULES.endsWith('=== END WASABICRM CHECKOUT RULES ==='),
  'wrapped with the required footer',
);
ok(WASABI_CHECKOUT_RULES.length > 8000, `body present (${WASABI_CHECKOUT_RULES.length} chars)`);

console.log(`\nrules constant = ${WASABI_CHECKOUT_RULES.length} chars`);
console.log(`options = ${CHECKOUT_MODE_OPTIONS.map((o) => `${o.value}/${o.shortLabel}`).join(', ')}`);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
