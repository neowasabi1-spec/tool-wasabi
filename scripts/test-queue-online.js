// Testa /api/openclaw/queue POST online con payload piccolo vs grosso,
// per riprodurre il 500 "Internal Error" che rompe lo swipe Morfeo/Neo.
const BASE = 'https://cute-cupcake-74bad8.netlify.app';

async function tryEnqueue(label, htmlBytes) {
  const html = htmlBytes > 0 ? 'x'.repeat(htmlBytes) : '';
  const swipePayload = {
    action: 'swipe_landing_local',
    sourceUrl: 'https://example.com/test',
    product: { name: 'Test', description: 'd', marketing_brief: 'b', market_research: 'm' },
    tone: 'professional',
    language: 'en',
    knowledge: { prompts: [], project: { name: 'Test', brief: null, market_research: null, notes: null } },
  };
  if (html) swipePayload.html = html;
  const body = JSON.stringify({ section: 'swipe_job', message: JSON.stringify(swipePayload), targetAgent: 'openclaw:morfeo' });
  const t = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + '/api/openclaw/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    text = await res.text();
  } catch (e) { console.log(`${label}: FETCH ERR`, e.message); return; }
  let j = null; try { j = JSON.parse(text); } catch {}
  const ms = Date.now() - t;
  console.log(`${label} (bodyKB=${Math.round(body.length/1024)}): status=${res.status} ${ms}ms ${j ? 'JSON id='+(j.id||j.error) : 'NON-JSON: '+text.slice(0,90).replace(/\s+/g,' ')}`);
  // cleanup se creato
  if (j && j.id) {
    await fetch(`${BASE}/api/openclaw/queue?id=${j.id}&reason=test-cleanup`, { method: 'DELETE' }).catch(()=>{});
  }
}

(async () => {
  await tryEnqueue('small ', 0);
  await tryEnqueue('500KB ', 500 * 1024);
  await tryEnqueue('1.5MB ', 1.5 * 1024 * 1024);
  await tryEnqueue('3MB   ', 3 * 1024 * 1024);
})();
