// Chiama i due endpoint che danno 500 e stampa il CORPO della risposta,
// che contiene la causa reale (es. "Supabase non configurato", crash, ecc.)
const BASE = 'https://cute-cupcake-74bad8.netlify.app';

async function probe(path, body, label) {
  const t = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    text = await res.text();
  } catch (e) { console.log(`${label}: FETCH ERR ${Date.now()-t}ms`, e.message); return; }
  console.log(`\n${label}  -> status ${res.status}  (${Date.now()-t}ms)  content-type=${res.headers.get('content-type')}`);
  console.log('BODY:', text.slice(0, 500).replace(/\s+/g,' '));
}

(async () => {
  // 1) proxy: una chiamata extract minimale (no Claude, solo per vedere se la route vive)
  await probe('/api/funnel-swap-proxy', { phase:'extract', cloneMode:'rewrite', url:'https://example.com', renderedHtml:'<html><body><p>hello world test</p></body></html>', userId:'00000000-0000-0000-0000-000000000001', productName:'x', productDescription:'y', targetLanguage:'en' }, 'PROXY extract minimale');

  // 2) openclaw/queue: enqueue minimale
  await probe('/api/openclaw/queue', { section:'swipe_job', message: JSON.stringify({action:'swipe_landing_local', sourceUrl:'https://example.com'}), targetAgent:'openclaw:morfeo' }, 'QUEUE enqueue minimale');
})();
