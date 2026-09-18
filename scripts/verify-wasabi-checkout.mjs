// Verification for the WasabiCRM checkout contract.
//
// Companion to scripts/verify-checkout-modes.mjs. That one proves the RULES
// TEXT is intact; this one proves the CODE that enforces it does what the text
// says — which is the half that was missing and the reason a page picked as
// "WasabiCRM" still came out unable to take a payment.
//
// Transpiles the real src/lib/wasabi-checkout-contract.ts with the project's
// own TypeScript, so what is tested is exactly what ships.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(resolve(ROOT, 'package.json'));
const ts = require('typescript');

const tsCache = new Map();

/**
 * Resolve the modules under test the way the app does, so they load
 * unmodified: `@/x` is the tsconfig alias for `src/x`, and a relative `./x`
 * is a sibling .ts file (the wasabi modules use relative imports because the
 * Netlify functions bundler does not honour the alias). Anything else is a
 * real node_module.
 */
function makeRequire(fromDir) {
  return (id) => {
    if (id.startsWith('@/')) return loadTs(resolve(ROOT, `src/${id.slice(2)}.ts`));
    if (id.startsWith('./') || id.startsWith('../')) return loadTs(`${resolve(fromDir, id)}.ts`);
    return require(id);
  };
}

function loadTs(pathOrRel) {
  const srcPath = resolve(ROOT, pathOrRel);
  if (tsCache.has(srcPath)) return tsCache.get(srcPath);
  const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  tsCache.set(srcPath, mod.exports);
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', js);
  fn(mod.exports, makeRequire(dirname(srcPath)), mod, srcPath, dirname(srcPath));
  tsCache.set(srcPath, mod.exports);
  return mod.exports;
}

const contract = loadTs('src/lib/wasabi-checkout-contract.ts');
const modes = loadTs('src/lib/checkout-modes.ts');

const {
  auditWasabiCheckout,
  repairWasabiCheckout,
  stripRuntimeConflicts,
  isWasabiCheckoutReady,
  WC_BIND_KEYS,
  WC_FIELD_NAMES,
  WC_RESERVED_IDS,
} = contract;
const { WASABI_CHECKOUT_RULES } = modes;

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
};
const fatalsOf = (issues) => issues.filter((i) => i.severity === 'fatal');
const hasRule = (issues, rule) => issues.some((i) => i.rule === rule);

// ── fixtures ──────────────────────────────────────────────────────────────

/** What Clone & Rewrite actually produces today: a competitor checkout with
 *  the copy swapped and not one attribute the payment runtime can bind to. */
const CLONED_CHECKOUT = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Secure Checkout</title>
<style>.box{padding:20px;border:1px solid #ddd}.cta{background:#0a0;color:#fff}</style>
</head>
<body>
  <div class="box">
    <h1>Complete your order</h1>
    <p class="total">Total today: $49.00</p>
    <form action="https://competitor.example/pay" method="post">
      <input type="text" name="first_name" placeholder="First name">
      <input type="email" name="customer_email" placeholder="Your email">
      <input type="tel" name="phone_number" placeholder="Phone">
      <button type="submit" class="cta">Complete my order</button>
    </form>
  </div>
</body></html>`;

/** The page from commit a834334: every data-wc-* attribute the old ruleset
 *  listed, and it still could not start a checkout because it hand-wrote the
 *  runtime <script src>, which suppresses the server's own injection. */
const REGRESSION_PAGE = `<!DOCTYPE html>
<html><head><title>Checkout</title>
<script src="/js/wasabi-checkout.js" defer></script>
</head><body>
  <input type="email" data-wc-field="email">
  <div data-wc-payment></div>
  <button type="button" data-wc-submit>Pay now</button>
</body></html>`;

/** Same failure, hidden in a comment: ensureScript() is textual and unanchored,
 *  so a commented-out tag suppresses the injection exactly as well. */
const COMMENTED_RUNTIME = `<!DOCTYPE html>
<html><head><title>Checkout</title>
<!-- <script src="/js/wasabi-page.js"></script> -->
</head><body>
  <input type="email" data-wc-field="email">
  <div data-wc-payment></div>
  <button type="button" data-wc-submit>Pay</button>
</body></html>`;

/** A page that already satisfies the contract. Must be left alone. */
const VALID_PAGE = `<!DOCTYPE html>
<html><head><title>Checkout</title></head><body>
  <div data-wc-options><template data-wc-option-item>
    <div class="card"><h3 data-wc-bind="option.name">Pack</h3><span data-wc-bind="option.total">$0.00</span></div>
  </template></div>
  <label>Email<input type="email" data-wc-field="email"></label>
  <div id="pay" data-wc-payment></div>
  <div data-wc-loading>Loading the secure form…</div>
  <button type="button" data-wc-submit>Complete order</button>
  <p>Total <span data-wc-bind="total">$0.00</span></p>
</body></html>`;

/** Nothing to do with a checkout — must come back byte for byte. */
const UNRELATED = `<!DOCTYPE html>
<html><head><title>Landing</title><script src="/js/app.js"></script></head>
<body><h1>Hello</h1><p>From $9 a month</p></body></html>`;

// ── §A  the cloned checkout: what the flag used to produce ────────────────

console.log('\n=== §A  a cloned checkout is NOT WasabiCRM-ready (the reported bug) ===');
const clonedAudit = auditWasabiCheckout(CLONED_CHECKOUT);
ok(fatalsOf(clonedAudit).length > 0, `a swiped competitor checkout audits as NOT ready (${fatalsOf(clonedAudit).length} payment-fatal)`);
ok(hasRule(clonedAudit, '§1.1'), 'reports the missing [data-wc-payment] mount');
ok(hasRule(clonedAudit, '§1.2'), 'reports the missing [data-wc-field="email"]');
ok(hasRule(clonedAudit, '§5.1'), 'reports the hardcoded price ($49.00) that would ship to a buyer');
ok(!isWasabiCheckoutReady(CLONED_CHECKOUT), 'isWasabiCheckoutReady() === false');

console.log('\n--- and the repair wires it up ---');
const repaired = repairWasabiCheckout(CLONED_CHECKOUT, { scaffold: true });
for (const r of repaired.repairs) console.log(`       ${r}`);
ok(/data-wc-payment/.test(repaired.html), 'the payment mount now exists');
ok(
  /<input[^>]*type="email"[^>]*data-wc-field="email"|data-wc-field="email"[^>]*type="email"/.test(repaired.html),
  'the page\'s OWN email input was claimed (not a new one bolted on)',
);
ok((repaired.html.match(/data-wc-field="email"/g) || []).length === 1, 'exactly one email field');
ok(/data-wc-field="firstName"/.test(repaired.html), 'the first-name input was claimed too');
ok(/data-wc-field="phone"/.test(repaired.html), 'the phone input was claimed too');
ok(/data-wc-submit/.test(repaired.html), 'the page\'s own CTA became the pay button');
ok(!/<form/i.test(repaired.html), '§4.3 the <form> became a <div> (nothing listens for submit)');
ok(!/type="submit"/i.test(repaired.html), '§1.5 no type="submit" control survives');
ok(/\.cta\{background:#0a0/.test(repaired.html.replace(/\s/g, '')), 'the design\'s stylesheet is untouched');
ok(hasRule(repaired.issues, '§5.1'), 'the hardcoded price is still reported (only the AI pass can decide which number is the price)');

// ── §B  the regression that broke a live checkout ─────────────────────────

console.log('\n=== §B  the hand-written runtime <script src> (commit a834334) ===');
const regAudit = auditWasabiCheckout(REGRESSION_PAGE);
ok(hasRule(regAudit, '§1.4'), 'a page with every data-wc-* attribute is STILL reported fatal for the runtime <script src>');
const regFixed = repairWasabiCheckout(REGRESSION_PAGE, { scaffold: false });
ok(!/wasabi-checkout\.js/.test(regFixed.html), 'the tag is removed from the output text, not just warned about');
ok(fatalsOf(regFixed.issues).length === 0, 'and nothing payment-fatal is left');

console.log('\n--- the same tag inside a comment (ensureScript is textual) ---');
ok(hasRule(auditWasabiCheckout(COMMENTED_RUNTIME), '§1.4'), 'a COMMENTED-OUT runtime tag is caught');
const commentFixed = repairWasabiCheckout(COMMENTED_RUNTIME, { scaffold: false });
ok(!/wasabi-page\.js/.test(commentFixed.html), 'and removed whole, comment included');

console.log('\n--- every runtime filename is covered ---');
for (const file of ['loader.js', 'wasabi-checkout.js', 'wasabi-page.js', 'whop-submit-button.js', 'wasabi-editor.js']) {
  const page = `<html><head><script src="/js/${file}"></script></head><body><div data-wc-payment></div><input type="email" data-wc-field="email"></body></html>`;
  ok(hasRule(auditWasabiCheckout(page), '§1.4'), `${file} is caught`);
}

console.log('\n--- <base> kills every same-origin call ---');
ok(hasRule(auditWasabiCheckout('<html><head><base href="/x"></head><body><div data-wc-payment></div><input type="email" data-wc-field="email"></body></html>'), '§0'), '<base> is fatal');

// ── §C  a valid page is left alone ────────────────────────────────────────

console.log('\n=== §C  a page that already satisfies the contract ===');
ok(isWasabiCheckoutReady(VALID_PAGE), 'audits as ready');
const validRepair = repairWasabiCheckout(VALID_PAGE, { scaffold: true });
ok(fatalsOf(validRepair.issues).length === 0, 'repair leaves it ready');
ok(/data-wc-option-item/.test(validRepair.html), 'the <template> blueprint survives (never mistaken for dead markup)');
ok(/data-wc-loading/.test(validRepair.html), 'the loading node survives');
ok((validRepair.html.match(/data-wc-payment/g) || []).length === 1, 'still exactly one payment mount');

console.log('\n--- repair is idempotent ---');
const once = repairWasabiCheckout(CLONED_CHECKOUT, { scaffold: true }).html;
const twice = repairWasabiCheckout(once, { scaffold: true }).html;
ok(once === twice, 'repair(repair(x)) === repair(x) on the cloned checkout');
const vOnce = repairWasabiCheckout(VALID_PAGE, { scaffold: true }).html;
ok(repairWasabiCheckout(vOnce, { scaffold: true }).html === vOnce, 'and on the valid page');

// ── §D  nothing leaks onto a page that is not a WasabiCRM checkout ────────

console.log('\n=== §D  the standard path stays byte-identical ===');
const untouched = stripRuntimeConflicts(UNRELATED);
ok(untouched.html === UNRELATED, 'stripRuntimeConflicts leaves ordinary HTML byte for byte');
ok(untouched.repairs.length === 0, 'and reports no repair');
ok(
  stripRuntimeConflicts('<div>x<script src="/js/wasabi-checkout.js"></script></div>').html === '<div>x</div>',
  'but still strips a runtime tag out of a FRAGMENT (the AI element editor\'s output)',
);

// ── §E  the money guard ───────────────────────────────────────────────────

console.log('\n=== §E  §5 money and bind keys ===');
const bindPage = `<html><body><div data-wc-payment></div><input type="email" data-wc-field="email">
<span data-wc-bind="option.renewal">every month</span><span data-wc-bind="made.up">x</span></body></html>`;
const bindFixed = repairWasabiCheckout(bindPage, { scaffold: false });
ok(/data-wc-bind="option\.terms"/.test(bindFixed.html), 'the `*.renewal` key models reach for is rewritten to the real `option.terms`');
ok(hasRule(bindFixed.issues, '§5.2'), 'an invented key is reported fatal (it resolves to null and ships the placeholder)');
ok(
  auditWasabiCheckout('<html><body><div data-wc-payment></div><input type="email" data-wc-field="email"><span data-wc-bind="product.price">$49.00</span></body></html>')
    .every((i) => i.rule !== '§5.1'),
  'a price INSIDE a data-wc-bind is expected, not a violation',
);
ok(
  hasRule(auditWasabiCheckout('<html><body><div data-wc-payment></div><input type="email" data-wc-field="email"><p>Only $19 today</p></body></html>'), '§5.1'),
  'a price OUTSIDE one is a violation',
);

// ── §Eb  the repair must not damage what it does not own ─────────────────

console.log('\n=== §Eb  blast radius ===');
const ariaPage = `<html><body>
<div role="tablist"><button role="tab" aria-checked="true" aria-disabled="false">FAQ</button></div>
<div data-wc-options><template data-wc-option-item><div aria-checked="true" class="card">x</div></template></div>
<div data-wc-payment></div><input type="email" data-wc-field="email"></body></html>`;
const ariaFixed = repairWasabiCheckout(ariaPage, { scaffold: false });
ok(/role="tab" aria-checked="true"/.test(ariaFixed.html), 'aria-checked on the page\'s OWN widget is left alone (§7: every other aria-* is the author\'s)');
ok(!/class="card"[^>]*aria-checked|aria-checked[^>]*class="card"/.test(ariaFixed.html), 'aria-checked inside an option card IS stripped (the runtime stamps it)');

const ctaPage = `<html><body>
<a href="#buy">Continue to checkout</a>
<input type="email" name="email">
<button class="real">Complete my order</button>
<footer><a href="/shop">Continue shopping</a></footer>
</body></html>`;
const ctaFixed = repairWasabiCheckout(ctaPage, { scaffold: true });
ok(/<button class="real"[^>]*data-wc-submit/.test(ctaFixed.html), 'the <button> is preferred over anchors that merely read like a CTA');
ok((ctaFixed.html.match(/data-wc-submit/g) || []).length === 1, 'and only one element is claimed');

ok(
  auditWasabiCheckout('<html><body><div data-wc-payment></div><input type="email" data-wc-field="email"><p>12 eurostar tickets</p></body></html>')
    .every((i) => i.rule !== '§5.1'),
  '"12 eurostar" is not a price (currency codes are word-bounded)',
);

const dupSubmit = auditWasabiCheckout('<html><body><div data-wc-payment></div><input type="email" data-wc-field="email"><button data-wc-submit type="submit">Pay</button></body></html>');
ok(dupSubmit.filter((i) => /type="submit"/.test(i.message)).length === 1, 'a type="submit" pay button is reported once, not once per matching selector');

// ── §F  the code and the model-facing text cannot drift ───────────────────

console.log('\n=== §F  every rule the code cites exists in WASABI_CHECKOUT_RULES ===');
const source = readFileSync(resolve(ROOT, 'src/lib/wasabi-checkout-contract.ts'), 'utf8');
const cited = [...new Set([...source.matchAll(/rule: '§([0-9.]+)'/g)].map((m) => m[1]))].sort();
ok(cited.length >= 12, `the module cites ${cited.length} rules: ${cited.join(', ')}`);
for (const id of cited) {
  const present = id.includes('.')
    ? WASABI_CHECKOUT_RULES.includes(`**${id} `) || WASABI_CHECKOUT_RULES.includes(`**${id} —`)
    : WASABI_CHECKOUT_RULES.includes(`## ${id}.`);
  ok(present, `§${id} is a real section of the ruleset`);
}

console.log('\n--- the vocabulary matches the ruleset ---');
for (const key of WC_BIND_KEYS) {
  ok(WASABI_CHECKOUT_RULES.includes(`\`${key}\``), `bind key ${key} is listed in §6`);
}
for (const name of WC_FIELD_NAMES) {
  ok(WASABI_CHECKOUT_RULES.includes(`\`${name}\``), `field name ${name} is listed`);
}
for (const id of WC_RESERVED_IDS) {
  ok(WASABI_CHECKOUT_RULES.includes(id), `reserved id ${id} is listed in §1.6`);
}

// ── §G  the conversion pipeline ───────────────────────────────────────────
//
// The model half cannot be exercised offline, but everything around it can —
// and every one of these is a way to silently ship a broken page.

console.log('\n=== §G  conversion pipeline (no model call) ===');
const build = loadTs('src/lib/wasabi-checkout-build.ts');

const HEAVY = `<!DOCTYPE html><html><head>
<style>${'.a{color:red}'.repeat(60)}</style>
<script>${'var x=1;'.repeat(60)}</script>
</head><body><img src="data:image/png;base64,${'A'.repeat(400)}">
<div data-wc-payment></div><input type="email" data-wc-field="email"></body></html>`;

const prot = build.protectHeavyParts(HEAVY);
ok(prot.html.length < HEAVY.length / 2, `stylesheets/scripts/images travel as tokens (${HEAVY.length} → ${prot.html.length} chars)`);
ok(prot.styleTokens === 1, 'the stylesheet was tokenised');
ok(!prot.html.includes('color:red'), 'no CSS body is sent to the model');
ok(build.restoreHeavyParts(prot.html, prot).html === HEAVY, 'restore is byte-exact when every token comes back');
ok(
  !/\/\*\s*\.a\{color:red\}/.test(build.restoreHeavyParts(prot.html, prot).html),
  'the /* */ wrapper goes WITH the token — a restored stylesheet left inside a comment is an unstyled checkout',
);
ok(
  build.restoreHeavyParts(prot.html.replace('/*__WCS_0__*/', '/*  __WCS_0__  */'), prot).html.includes('.a{color:red}.a{color:red}'),
  'and the wrapper is still matched when the model reformats the whitespace in it',
);

const dropped = build.restoreHeavyParts(prot.html.replace(/\/\*__WCS_\d+__\*\//, ''), prot);
ok(dropped.missingStyles === 1, 'a stylesheet the model deleted is counted, so the attempt can be discarded');

const noKeyEnv = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const floorOnly = await build.convertToWasabiCheckout({ html: CLONED_CHECKOUT });
ok(floorOnly.aiUsed === false, 'with no API key the model is never called');
ok(/data-wc-payment/.test(floorOnly.html), 'and the page still comes back wired as far as a machine can take it');
ok(floorOnly.ready === false, 'ready=false, because the hardcoded price needs judgement');
ok(/ANTHROPIC_API_KEY/.test(floorOnly.error || ''), 'and the reason is reported, not swallowed');

const alreadyGood = await build.convertToWasabiCheckout({ html: VALID_PAGE });
ok(alreadyGood.ready === true && alreadyGood.attempts === 0, 'a page that already satisfies the contract costs zero model calls');
ok(alreadyGood.html.includes('data-wc-option-item'), 'and is returned intact');

// netlify/functions/pipeline-swipe-background.mts imports these directly, and
// the functions bundler does not resolve the `@/` tsconfig alias — an alias
// here builds fine and then throws at runtime inside the background worker.
for (const rel of ['src/lib/wasabi-checkout-build.ts', 'src/lib/wasabi-checkout-contract.ts', 'src/lib/checkout-modes.ts']) {
  const imports = [...readFileSync(resolve(ROOT, rel), 'utf8').matchAll(/^\s*import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  ok(imports.every((i) => !i.startsWith('@/')), `${rel} uses no '@/' alias (the Netlify bundler cannot resolve it)`);
}

const empty = await build.convertToWasabiCheckout({ html: '' });
ok(empty.error === 'empty html' && empty.html === '', 'empty input is handled, not crashed on');
if (noKeyEnv !== undefined) process.env.ANTHROPIC_API_KEY = noKeyEnv;

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
