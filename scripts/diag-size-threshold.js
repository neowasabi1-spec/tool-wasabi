// Find the body-size threshold at which POST /api/openclaw/queue starts
// returning a non-JSON Netlify "Internal Error" instead of 200 JSON.
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const sizesMb = [3, 4, 5, 6, 7, 8];

async function tryPost(mb) {
  const message = 'X'.repeat(mb * 1024 * 1024);
  const body = JSON.stringify({ section: 'diag_test', message, targetAgent: 'openclaw:__diag__' });
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + '/api/openclaw/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const ms = Date.now() - t0;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    const isJson = ct.includes('application/json');
    console.log(
      `~${mb}MB (body=${body.length}) -> status=${res.status} ct=${ct} ms=${ms} ${isJson ? 'JSON' : 'NON-JSON!'} head=${text.slice(0, 80).replace(/\n/g, ' ')}`,
    );
  } catch (e) {
    console.log(`~${mb}MB -> THREW ${e.message} (${Date.now() - t0}ms)`);
  }
}

(async () => {
  for (const mb of sizesMb) await tryPost(mb);
})();
