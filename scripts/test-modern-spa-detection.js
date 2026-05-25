// Sanity test for detectModernSpa logic in worker-lib/finalize.js
// Run: node scripts/test-modern-spa-detection.js
// Each test prints a one-line summary + PASS/FAIL based on expectations.
// Delete this file after manual verification or keep for regression.

const { finalizeSwipe } = require('../worker-lib/finalize.js');

const tests = [
  {
    name: 'Vite/Replit (FiberMuse-style)',
    html: '<!DOCTYPE html><html><head><title>T</title></head><body><div id="root"><h1>Hello World</h1></div><script type="module" src="/assets/index-ABCD1234.js"></script></body></html>',
    sourceUrl: 'https://fiber-muse-product-page.replit.app/',
    texts: [{ id: 0, original: 'Hello World', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao Mondo' }],
    expect: {
      modern_spa_detected: true,
      spa_preview_mode_applied: false,
      bundlePreserved: '/assets/index-ABCD1234.js',
    },
  },
  {
    name: 'Lovable hostname (root-only shell)',
    html: '<!DOCTYPE html><html><head></head><body><div id="root"><span>X</span></div><script src="/legacy.js"></script></body></html>',
    sourceUrl: 'https://myapp.lovable.app/',
    texts: [{ id: 0, original: 'X', tag: 'mixed:span' }],
    rewrites: [{ id: 0, rewritten: 'Y' }],
    expect: {
      modern_spa_detected: true,
      spa_preview_mode_applied: false,
    },
  },
  {
    name: 'Classic Funnelish/jQuery (CheckoutChamp host)',
    html: '<!DOCTYPE html><html><head><title>T</title></head><body><div data-v-abc123><h1>Hello World</h1></div><script src="/jquery.min.js"></script><script>jQuery(function(){});</script></body></html>',
    sourceUrl: 'https://example.checkoutchamp.com/',
    texts: [{ id: 0, original: 'Hello World', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao Mondo' }],
    expect: {
      modern_spa_detected: false,
      spa_preview_mode_applied: true,
      scriptsStripped: 'jquery.min.js',
    },
  },
  {
    name: 'Next.js SSR (Nooro-style)',
    html: '<!DOCTYPE html><html><head></head><body><div id="__next"><h1>Hi</h1></div><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script></body></html>',
    sourceUrl: 'https://nooro.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      is_spa_page: true,
      modern_spa_detected: false,
      spa_preview_mode_applied: true,
      scriptsStripped: '/_next/static/chunks/main.js',
    },
  },
  {
    name: 'Vue/Vite v2 with all-module signature',
    html: '<!DOCTYPE html><html><head></head><body><div id="app"><p>Hi</p></div><script type="module" src="/src/main.ts"></script></body></html>',
    sourceUrl: 'https://example.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:p' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      modern_spa_detected: true,
      spa_preview_mode_applied: false,
    },
  },
  {
    name: 'Static jQuery page (no SPA at all)',
    html: '<!DOCTYPE html><html><head></head><body><h1>Hi</h1><script src="/jquery.min.js"></script></body></html>',
    sourceUrl: 'https://static.example.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      is_spa_page: false,
      modern_spa_detected: false,
      spa_preview_mode_applied: false,
    },
  },
];

let pass = 0;
let fail = 0;
for (const t of tests) {
  const r = finalizeSwipe({
    html: t.html,
    sourceUrl: t.sourceUrl,
    texts: t.texts,
    rewrites: t.rewrites,
    productName: 'Test',
  });
  const checks = [];
  if (t.expect.modern_spa_detected !== undefined) {
    checks.push({
      what: 'modern_spa_detected',
      got: r.modern_spa_detected,
      want: t.expect.modern_spa_detected,
    });
  }
  if (t.expect.spa_preview_mode_applied !== undefined) {
    checks.push({
      what: 'spa_preview_mode_applied',
      got: r.spa_preview_mode_applied,
      want: t.expect.spa_preview_mode_applied,
    });
  }
  if (t.expect.is_spa_page !== undefined) {
    checks.push({
      what: 'is_spa_page',
      got: r.is_spa_page,
      want: t.expect.is_spa_page,
    });
  }
  if (t.expect.bundlePreserved) {
    checks.push({
      what: `bundle "${t.expect.bundlePreserved}" preserved`,
      got: r.html.includes(t.expect.bundlePreserved),
      want: true,
    });
  }
  if (t.expect.scriptsStripped) {
    checks.push({
      what: `script "${t.expect.scriptsStripped}" stripped`,
      got: !r.html.includes(t.expect.scriptsStripped),
      want: true,
    });
  }
  const allOk = checks.every((c) => c.got === c.want);
  if (allOk) pass++;
  else fail++;
  console.log(`${allOk ? 'PASS' : 'FAIL'}  ${t.name}  reason=${r.modern_spa_reason}`);
  for (const c of checks) {
    if (c.got !== c.want) {
      console.log(`         × ${c.what}: got ${c.got}, want ${c.want}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
