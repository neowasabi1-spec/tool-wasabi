// Chiama il PROXY Netlify reale (/api/funnel-swap-proxy) come fa il browser,
// per riprodurre il 500 "Internal Error" sull'extract.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');

const BASE = process.env.APP_BASE || 'https://cute-cupcake-74bad8.netlify.app';

async function call(label, body) {
  const t = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + '/api/funnel-swap-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) { console.log(label, 'FETCH ERR', Date.now() - t, 'ms:', e.message); return; }
  console.log(`${label}: status=${res.status} time=${Date.now()-t}ms ct=${res.headers.get('content-type')}`);
  console.log('   body:', text.slice(0, 300).replace(/\s+/g, ' '));
}

(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('original_html,url,product_name').order('created_at', { ascending: false }).limit(8);
  const job = jobs.find((j) => j.original_html && j.original_html.length > 1000);
  console.log('BASE', BASE, '| html len', job.original_html.length, '\n');

  const base = {
    phase: 'extract', url: job.url, cloneMode: 'rewrite',
    productName: job.product_name || 'NeuroFlush', productDescription: 'test',
    targetLanguage: 'en', userId: '00000000-0000-0000-0000-000000000001',
    renderedHtml: job.original_html,
  };
  // 1) solo HTML (snello)
  await call('A) solo html        ', base);
  // 2) con brief/MR grossi (come manda il frontend)
  const big = 'X'.repeat(144000);
  await call('B) html+brief+MR big ', { ...base, brief: big, market_research: 'Y'.repeat(64000) });
  // 3) con brief_files/research_files (array file, come cloneRoutingPayload)
  await call('C) +brief_files arr  ', { ...base, brief_files: [{ name: 'brief.txt', content: big }], research_files: [{ name: 'mr.txt', content: 'Y'.repeat(64000) }], pageType: 'pdp' });
})();
