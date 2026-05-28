/* eslint-disable no-console */
/**
 * Test del fix "Filament Group loadCSS preload pattern" in
 * src/lib/inline-assets.ts.
 *
 * Verifichiamo che quando un <link rel="stylesheet"> arriva con
 *
 *   media="print"  + onload="this.media='all'"
 *
 * (il pattern standard di async-CSS load) NON ereditiamo
 * `media="print"` nel <style> inlinato. Altrimenti il foglio
 * resta confinato alla stampa e regole tipo Font Awesome / web
 * font / Tailwind utility non si applicano a video.
 *
 * Eseguire:
 *   node scripts/test-inline-assets-preload.js
 *
 * Prerequisito: TS gia' compilato in .test-out/. Compila con:
 *   npx tsc --target es2020 --module commonjs --outDir .test-out \
 *     --esModuleInterop --skipLibCheck src/lib/inline-assets.ts
 */
'use strict';

const path = require('path');

let inlineExternalAssets;
try {
  ({ inlineExternalAssets } = require(path.resolve(
    __dirname,
    '..',
    '.test-out',
    'inline-assets.js',
  )));
} catch (e) {
  console.error(
    '[test] impossibile caricare .test-out/inline-assets.js — esegui prima:',
  );
  console.error(
    '       npx tsc --target es2020 --module commonjs --outDir .test-out \\',
  );
  console.error(
    '         --esModuleInterop --skipLibCheck src/lib/inline-assets.ts',
  );
  process.exit(1);
}

const FAKE_CSS = `
/* fake font awesome */
.fa-check-circle::before { content: "\\f058"; font-family: "FA"; }
.fa-times-circle::before { content: "\\f057"; font-family: "FA"; }
`;

const origFetch = global.fetch;
global.fetch = async function mockedFetch(url, _opts) {
  return {
    ok: true,
    headers: { get: () => 'text/css' },
    arrayBuffer: async () => new TextEncoder().encode(FAKE_CSS).buffer,
  };
};

function expect(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

(async () => {
  const baseUrl = 'https://example.test/page';

  // ───────────────────────────────────────────────────────────────────────
  // 1) preload pattern classico: media="print" + onload="this.media='all'"
  //    → il <style> NON deve avere media="print".
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<html><head>' +
      '<link rel="stylesheet" media="print" onload="this.media=\'all\'" ' +
      'href="https://cdn.example/fa.css">' +
      '</head><body></body></html>';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(/<style\b[^>]*data-inlined-from="https:\/\/cdn\.example\/fa\.css"[^>]*>/.test(out), '#1 stylesheet inlinato');
    expect(!/media="print"/.test(out), '#1 NESSUN media="print" nello <style> (preload pattern promosso a all)');
    expect(/\.fa-check-circle/.test(out), '#1 contenuto CSS inserito');
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2) variante con virgolette singole all'esterno: onload='this.media="all"'
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<link rel="stylesheet" media="print" onload=\'this.media="all"\' ' +
      'href="https://cdn.example/anim.css">';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(!/media="print"/.test(out), '#2 variante quote-swap: niente media="print"');
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3) preload pattern variante "not all": media="not all" + onload
  //    this.media='all' → comunque promosso ad 'all' (default).
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<link rel="stylesheet" media="not all" onload="this.media=\'all\'" ' +
      'href="https://cdn.example/notall.css">';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(!/media="(print|not all)"/.test(out), '#3 not all → promosso a all');
  }

  // ───────────────────────────────────────────────────────────────────────
  // 4) link normale CON media="print" e SENZA onload → resta print
  //    (legittimo: stylesheet per la stampa).
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<link rel="stylesheet" media="print" href="https://cdn.example/printer.css">';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(/media="print"/.test(out), '#4 print-only legittimo: media="print" preservato');
  }

  // ───────────────────────────────────────────────────────────────────────
  // 5) link normale (no media, no onload) → no attributo media nello <style>
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<link rel="stylesheet" href="https://cdn.example/plain.css">';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(!/media="/.test(out), '#5 stylesheet plain: nessun media nello <style>');
  }

  // ───────────────────────────────────────────────────────────────────────
  // 6) link "screen and (max-width:600px)" → preservato (legittimo)
  // ───────────────────────────────────────────────────────────────────────
  {
    const html =
      '<link rel="stylesheet" media="screen and (max-width: 600px)" ' +
      'href="https://cdn.example/mobile.css">';
    const out = await inlineExternalAssets(html, baseUrl);
    expect(/media="screen and \(max-width: 600px\)"/.test(out), '#6 media query legittima preservata');
  }

  global.fetch = origFetch;
  if (process.exitCode === 1) {
    console.error('\nALCUNI TEST FALLITI');
  } else {
    console.log('\nTUTTI I TEST OK');
  }
})();
