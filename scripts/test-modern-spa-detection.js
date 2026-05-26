// Sanity test per finalizeSwipe:
//   - detectModernSpa() telemetria
//   - SPA preview mode (script strip) si applica a TUTTE le SPA, incluse
//     le modern-SPA Vite/Replit (no exception)
//   - absolutizeAssetUrls() risolve gli URL relativi degli asset
//     all'origin sorgente (fix layout "tutta sconfusionata")
//
// Run: node scripts/test-modern-spa-detection.js

const { finalizeSwipe } = require('../worker-lib/finalize.js');

const tests = [
  {
    name: 'Vite/Replit (FiberMuse-style) — strip + absolutize',
    html:
      '<!DOCTYPE html><html><head><title>T</title>' +
      '<link rel="stylesheet" href="/assets/index-ABCD.css">' +
      '<link rel="icon" href="/favicon.ico">' +
      '</head><body><div id="root"><h1>Hello World</h1>' +
      '<img src="/img/hero.jpg" alt=""></div>' +
      '<script type="module" src="/assets/index-XYZ.js"></script>' +
      '</body></html>',
    sourceUrl: 'https://fiber-muse-product-page.replit.app/',
    texts: [{ id: 0, original: 'Hello World', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao Mondo' }],
    expect: {
      modern_spa_detected: true,
      spa_preview_mode_applied: true,
      asset_urls_absolutized: true,
      // CSS deve diventare absolute → origin replit
      htmlIncludes: [
        'href="https://fiber-muse-product-page.replit.app/assets/index-ABCD.css"',
        'href="https://fiber-muse-product-page.replit.app/favicon.ico"',
        'src="https://fiber-muse-product-page.replit.app/img/hero.jpg"',
      ],
      // Lo script bundle DEVE essere strippato (revert del comportamento
      // precedente "preserva i module su modern SPA")
      htmlExcludes: ['src="/assets/index-XYZ.js"', 'src="https://fiber-muse-product-page.replit.app/assets/index-XYZ.js"'],
    },
  },
  {
    name: 'Lovable hostname — strip + absolutize',
    html:
      '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="/styles.css">' +
      '</head><body><div id="root"><span>X</span></div>' +
      '<script src="/legacy.js"></script></body></html>',
    sourceUrl: 'https://myapp.lovable.app/',
    texts: [{ id: 0, original: 'X', tag: 'mixed:span' }],
    rewrites: [{ id: 0, rewritten: 'Y' }],
    expect: {
      modern_spa_detected: true,
      spa_preview_mode_applied: true,
      htmlIncludes: ['href="https://myapp.lovable.app/styles.css"'],
      htmlExcludes: ['src="/legacy.js"'],
    },
  },
  {
    name: 'Classic Funnelish/jQuery — strip + absolutize (no modern SPA)',
    html:
      '<!DOCTYPE html><html><head><title>T</title>' +
      '<link rel="stylesheet" href="/css/main.css">' +
      '</head><body><div data-v-abc123><h1>Hello World</h1>' +
      '<img src="hero.png" alt="">' +
      '</div>' +
      '<script src="/jquery.min.js"></script>' +
      '<script>jQuery(function(){});</script></body></html>',
    sourceUrl: 'https://example.checkoutchamp.com/page/x',
    texts: [{ id: 0, original: 'Hello World', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao Mondo' }],
    expect: {
      modern_spa_detected: false,
      spa_preview_mode_applied: true, // data-v-abc123 → SPA detection
      htmlIncludes: [
        'href="https://example.checkoutchamp.com/css/main.css"',
        // path-relative "hero.png" risolto contro la sourceUrl
        'src="https://example.checkoutchamp.com/page/hero.png"',
      ],
      htmlExcludes: ['src="/jquery.min.js"'],
    },
  },
  {
    name: 'Next.js SSR (Nooro-style) — strip + absolutize',
    html:
      '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="/_next/static/css/app.css">' +
      '</head><body><div id="__next"><h1>Hi</h1></div>' +
      '<script id="__NEXT_DATA__" type="application/json">{}</script>' +
      '<script src="/_next/static/chunks/main.js"></script></body></html>',
    sourceUrl: 'https://nooro.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      is_spa_page: true,
      modern_spa_detected: false,
      spa_preview_mode_applied: true,
      htmlIncludes: ['href="https://nooro.com/_next/static/css/app.css"'],
      htmlExcludes: ['src="/_next/static/chunks/main.js"'],
    },
  },
  {
    name: 'Vue/Vite v2 (id=app + module main.ts) — strip + absolutize',
    html:
      '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="/style.css">' +
      '</head><body><div id="app"><p>Hi</p></div>' +
      '<script type="module" src="/src/main.ts"></script></body></html>',
    sourceUrl: 'https://example.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:p' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      modern_spa_detected: true,
      htmlIncludes: ['href="https://example.com/style.css"'],
    },
  },
  {
    name: 'Static jQuery page (no SPA, no strip, ma absolutize si)',
    html:
      '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="/css/site.css">' +
      '</head><body><h1>Hi</h1>' +
      '<img srcset="/img/x.png 1x, /img/x@2x.png 2x" src="/img/x.png">' +
      '<script src="/jquery.min.js"></script></body></html>',
    sourceUrl: 'https://static.example.com/sub/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      is_spa_page: false,
      modern_spa_detected: false,
      spa_preview_mode_applied: false,
      htmlIncludes: [
        'href="https://static.example.com/css/site.css"',
        'srcset="https://static.example.com/img/x.png 1x, https://static.example.com/img/x@2x.png 2x"',
        // Lo script qui NON viene strippato (pagina non-SPA), e l'URL viene assolutizzato
        'src="https://static.example.com/jquery.min.js"',
      ],
    },
  },
  {
    name: 'Already-absolute URLs e data: URIs non vengono toccate',
    html:
      '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="https://cdn.example.org/lib.css">' +
      '<link rel="icon" href="data:image/x-icon;base64,AAAA">' +
      '</head><body><h1>Hi</h1>' +
      '<img src="//cdn.example.com/proto-rel.png">' +
      '</body></html>',
    sourceUrl: 'https://site.example.net/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      htmlIncludes: [
        'href="https://cdn.example.org/lib.css"', // invariato
        'href="data:image/x-icon;base64,AAAA"', // invariato
        // protocol-relative riceve il proto della sourceUrl
        'src="https://cdn.example.com/proto-rel.png"',
      ],
    },
  },
  {
    name: '<a href> e <form action> NON vengono assolutizzati',
    html:
      '<!DOCTYPE html><html><head></head><body>' +
      '<a href="/buy">Buy</a>' +
      '<form action="/checkout"><button>Go</button></form>' +
      '<h1>Hi</h1>' +
      '</body></html>',
    sourceUrl: 'https://competitor.com/',
    texts: [{ id: 0, original: 'Hi', tag: 'mixed:h1' }],
    rewrites: [{ id: 0, rewritten: 'Ciao' }],
    expect: {
      htmlIncludes: ['href="/buy"', 'action="/checkout"'],
      htmlExcludes: ['href="https://competitor.com/buy"', 'action="https://competitor.com/checkout"'],
    },
  },
];

let pass = 0;
let fail = 0;
for (const t of tests) {
  let r;
  try {
    r = finalizeSwipe({
      html: t.html,
      sourceUrl: t.sourceUrl,
      texts: t.texts,
      rewrites: t.rewrites,
      productName: 'Test',
    });
  } catch (e) {
    console.log(`FAIL  ${t.name}  → threw ${e.message}`);
    fail++;
    continue;
  }
  const checks = [];
  for (const key of ['modern_spa_detected', 'spa_preview_mode_applied', 'is_spa_page', 'asset_urls_absolutized']) {
    if (t.expect[key] !== undefined) {
      checks.push({ what: key, got: r[key], want: t.expect[key] });
    }
  }
  for (const needle of t.expect.htmlIncludes || []) {
    checks.push({ what: `html includes "${needle}"`, got: r.html.includes(needle), want: true });
  }
  for (const needle of t.expect.htmlExcludes || []) {
    checks.push({ what: `html excludes "${needle}"`, got: !r.html.includes(needle), want: true });
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
