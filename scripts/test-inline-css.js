/* eslint-disable no-console */
/**
 * Test offline di worker-lib/inline-css.js.
 * Usa un fetch mockato in modo da NON dipendere da rete o da Replit.
 *
 * Eseguire:
 *   node scripts/test-inline-css.js
 */

'use strict';

const {
  inlineExternalStylesheets,
  findStylesheetCandidates,
  rewriteCssUrls,
  rewriteCssImports,
} = require('../worker-lib/inline-css');

// ─────────────────────────────────────────────────────────────────
// Mock global fetch — niente rete reale durante i test.
// ─────────────────────────────────────────────────────────────────
const MOCK_RESPONSES = new Map();

function mockCss(url, css) {
  MOCK_RESPONSES.set(url, { ok: true, css });
}

function mockHttpError(url, status) {
  MOCK_RESPONSES.set(url, { ok: false, status });
}

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const rec = MOCK_RESPONSES.get(String(url));
  if (!rec) {
    return {
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (!rec.ok) {
    return {
      ok: false,
      status: rec.status,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  const buf = Buffer.from(rec.css, 'utf8');
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

// ─────────────────────────────────────────────────────────────────
// Test runner minimale
// ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
      console.log(`  ✗ ${name}`);
      console.log(`      ${e.message}`);
    }
  })();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg || 'assertEq failed'}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`,
    );
  }
}

function assertIncludes(haystack, needle, msg) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(
      `${msg || 'assertIncludes failed'}\n      haystack: ${String(haystack).slice(0, 400)}…\n      needle:   ${needle}`,
    );
  }
}

function assertExcludes(haystack, needle, msg) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    throw new Error(
      `${msg || 'assertExcludes failed'}\n      haystack contains: ${needle}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n=== rewriteCssUrls ===');

  await test('riscrive url() relativi contro URL del CSS', () => {
    const css = `
      .a { background: url(foo.png); }
      .b { background: url("./img/bar.png"); }
      .c { background: url('../fonts/x.woff2'); }
      .d { background: url(/abs/y.svg); }
    `;
    const out = rewriteCssUrls(css, 'https://example.com/assets/x.css');
    assertIncludes(out, 'url(https://example.com/assets/foo.png)');
    assertIncludes(out, 'url("https://example.com/assets/img/bar.png")');
    assertIncludes(out, "url('https://example.com/fonts/x.woff2')");
    assertIncludes(out, 'url(https://example.com/abs/y.svg)');
  });

  await test('lascia intatti url() assoluti, data:, //', () => {
    const css = `
      .a { background: url(https://cdn.example.com/x.png); }
      .b { background: url(//cdn2.example.com/y.png); }
      .c { background: url(data:image/png;base64,AAAA); }
      .d { background: url(#fragment); }
    `;
    const out = rewriteCssUrls(css, 'https://example.com/x.css');
    assertIncludes(out, 'url(https://cdn.example.com/x.png)');
    assertIncludes(out, 'url(//cdn2.example.com/y.png)');
    assertIncludes(out, 'url(data:image/png;base64,AAAA)');
    assertIncludes(out, 'url(#fragment)');
  });

  console.log('\n=== rewriteCssImports ===');

  await test('riscrive @import "..." senza url()', () => {
    const css = `
      @import "/foo/base.css";
      @import 'theme.css';
      @import "https://fonts.googleapis.com/css2?family=Inter";
    `;
    const out = rewriteCssImports(css, 'https://example.com/assets/main.css');
    assertIncludes(out, '@import "https://example.com/foo/base.css"');
    assertIncludes(out, "@import 'https://example.com/assets/theme.css'");
    assertIncludes(out, '@import "https://fonts.googleapis.com/css2?family=Inter"');
  });

  console.log('\n=== findStylesheetCandidates ===');

  await test('matcha <link rel="stylesheet" href="...">', () => {
    const html = `
      <link rel="stylesheet" href="/assets/index.css">
      <link rel="stylesheet" crossorigin href="/assets/index-3HlEuuN1.css">
      <link href="/assets/other.css" rel='stylesheet'>
      <link rel="preload" as="style" href="/skip.css">
      <link rel="stylesheet" href="">
      <link rel="stylesheet" disabled href="/disabled.css">
    `;
    const cands = findStylesheetCandidates(html, 'https://example.com/');
    const urls = cands.map((c) => c.absUrl);
    assertEq(urls.length, 3, `dovrei trovare 3 stylesheet, trovati ${urls.length}: ${urls.join(', ')}`);
    assertIncludes(urls.join(','), 'https://example.com/assets/index.css');
    assertIncludes(urls.join(','), 'https://example.com/assets/index-3HlEuuN1.css');
    assertIncludes(urls.join(','), 'https://example.com/assets/other.css');
    assert(!urls.some((u) => u.includes('skip.css')), 'non deve catturare preload');
    assert(!urls.some((u) => u.includes('disabled.css')), 'non deve catturare disabled');
  });

  await test('dedupe href identici', () => {
    const html = `
      <link rel="stylesheet" href="/x.css">
      <link rel="stylesheet" href="/x.css">
    `;
    const cands = findStylesheetCandidates(html, 'https://example.com/');
    assertEq(cands.length, 1);
  });

  console.log('\n=== inlineExternalStylesheets (Replit/Vite scenario) ===');

  await test('inlina CSS Vite con crossorigin e riscrive url() interni', async () => {
    MOCK_RESPONSES.clear();
    mockCss(
      'https://fiber-muse-product-page.replit.app/assets/index-3HlEuuN1.css',
      `
        :root { --bg: #fff; }
        body { background: url(/assets/bg.png); font-family: 'Inter'; }
        @font-face { font-family: 'Inter'; src: url('./fonts/Inter.woff2'); }
        @import url("https://fonts.googleapis.com/css2?family=Inter");
      `,
    );

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" crossorigin href="/assets/index-3HlEuuN1.css">
  <title>Fiber Muse</title>
</head>
<body><div id="app"></div></body>
</html>`;

    const res = await inlineExternalStylesheets(
      html,
      'https://fiber-muse-product-page.replit.app/',
    );

    assertEq(res.inlined, 1, 'deve inlinare 1 stylesheet');
    assertEq(res.failed, 0);
    assertExcludes(
      res.html,
      '<link rel="stylesheet" crossorigin href="/assets/index-3HlEuuN1.css">',
      'il <link> originale deve sparire',
    );
    assertIncludes(res.html, '<style data-inlined-from="https://fiber-muse-product-page.replit.app/assets/index-3HlEuuN1.css"');
    assertIncludes(
      res.html,
      'url(https://fiber-muse-product-page.replit.app/assets/bg.png)',
      'url(/assets/bg.png) deve essere assolutizzato contro l\'URL del CSS',
    );
    assertIncludes(
      res.html,
      "url('https://fiber-muse-product-page.replit.app/assets/fonts/Inter.woff2')",
      '@font-face url() deve essere assolutizzato',
    );
    assertIncludes(
      res.html,
      'url("https://fonts.googleapis.com/css2?family=Inter")',
      '@import url() esterno deve restare cosi com\'e\'',
    );
  });

  await test('inlina multi-stylesheet, mantiene ordine, dedupe', async () => {
    MOCK_RESPONSES.clear();
    mockCss('https://x.com/a.css', '.a{color:red}');
    mockCss('https://x.com/b.css', '.b{color:blue}');

    const html = `
      <head>
        <link rel="stylesheet" href="/a.css">
        <link rel="stylesheet" href="/b.css">
      </head>
    `;
    const res = await inlineExternalStylesheets(html, 'https://x.com/');
    assertEq(res.inlined, 2);
    assert(res.html.indexOf('.a{color:red}') < res.html.indexOf('.b{color:blue}'), 'ordine preservato');
  });

  await test('fallback graceful su HTTP 404', async () => {
    MOCK_RESPONSES.clear();
    mockHttpError('https://x.com/missing.css', 404);

    const html = `<head><link rel="stylesheet" href="/missing.css"></head>`;
    const res = await inlineExternalStylesheets(html, 'https://x.com/');
    assertEq(res.inlined, 0);
    assertEq(res.failed, 1);
    assertIncludes(res.html, '<link rel="stylesheet" href="/missing.css">', 'tag originale deve restare al suo posto');
    assert(res.errors[0].includes('HTTP 404'), `errore deve menzionare 404, ha: ${res.errors[0]}`);
  });

  await test('mix: alcuni OK, altri 404 — l\'HTML risultante ha gli OK inlinati e i KO restano <link>', async () => {
    MOCK_RESPONSES.clear();
    mockCss('https://x.com/ok.css', '.ok{}');
    mockHttpError('https://x.com/ko.css', 500);

    const html = `
      <head>
        <link rel="stylesheet" href="/ok.css">
        <link rel="stylesheet" href="/ko.css">
      </head>
    `;
    const res = await inlineExternalStylesheets(html, 'https://x.com/');
    assertEq(res.inlined, 1);
    assertEq(res.failed, 1);
    assertIncludes(res.html, '.ok{}');
    assertIncludes(res.html, '<link rel="stylesheet" href="/ko.css">');
  });

  await test('no sourceUrl → no-op', async () => {
    const html = `<head><link rel="stylesheet" href="/a.css"></head>`;
    const res = await inlineExternalStylesheets(html, '', {});
    assertEq(res.inlined, 0);
    assertEq(res.html, html, 'HTML deve restare identico');
  });

  await test('no <link> → no-op', async () => {
    const html = `<head><meta charset="utf8"></head>`;
    const res = await inlineExternalStylesheets(html, 'https://x.com/');
    assertEq(res.inlined, 0);
    assertEq(res.html, html);
  });

  await test('CheckoutChamp-style classic CSS reference', async () => {
    MOCK_RESPONSES.clear();
    mockCss('https://cdn.checkoutchamp.com/css/style.css', '.checkout{padding:10px}');

    const html = `
      <html>
      <head>
        <link href="https://cdn.checkoutchamp.com/css/style.css" rel="stylesheet" type="text/css">
      </head>
      </html>
    `;
    const res = await inlineExternalStylesheets(html, 'https://shop.example.com/checkout');
    assertEq(res.inlined, 1);
    assertIncludes(res.html, '.checkout{padding:10px}');
  });

  await test('Lovable-style modulepreload + stylesheet', async () => {
    MOCK_RESPONSES.clear();
    mockCss('https://my-app.lovable.app/assets/main.css', '.lovable{}');

    const html = `
      <head>
        <link rel="modulepreload" href="/assets/main.js">
        <link rel="stylesheet" crossorigin href="/assets/main.css">
      </head>
    `;
    const res = await inlineExternalStylesheets(html, 'https://my-app.lovable.app/');
    assertEq(res.inlined, 1);
    assertExcludes(res.html, '<link rel="stylesheet" crossorigin href="/assets/main.css">');
    assertIncludes(res.html, '<link rel="modulepreload" href="/assets/main.js">', 'modulepreload deve restare');
  });

  // ── Final report ──────────────────────────────────────────────
  global.fetch = originalFetch;
  console.log(`\nRisultati: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('Test runner crash:', e);
  process.exit(2);
});
