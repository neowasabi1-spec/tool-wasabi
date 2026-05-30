// Hit the production endpoints involved in a Riscrivi and report exactly
// what each returns (status, content-type, first bytes). No guessing.
const BASE = 'https://cute-cupcake-74bad8.netlify.app';

async function hit(method, path, body) {
  const url = BASE + path;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const ms = Date.now() - t0;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    const head = text.slice(0, 160).replace(/\n/g, ' ');
    console.log(`\n${method} ${path}`);
    console.log(`  status=${res.status} ct=${ct} ms=${ms} len=${text.length}`);
    console.log(`  head=${head}`);
  } catch (e) {
    console.log(`\n${method} ${path}`);
    console.log(`  THREW: ${e.message} (${Date.now() - t0}ms)`);
  }
}

(async () => {
  await hit('GET', '/api/swipe/load-knowledge');
  await hit('POST', '/api/clone-funnel', {
    url: 'https://example.com',
    cloneMode: 'identical',
    viewport: 'desktop',
    keepScripts: true,
  });
  await hit('POST', '/api/funnel-swap-proxy', {
    phase: 'extract',
    cloneMode: 'rewrite',
    url: 'https://example.com',
    renderedHtml: '<html><body><h1>Hello</h1><p>Test paragraph for extraction.</p></body></html>',
    pageType: 'pdp',
  });
})();
