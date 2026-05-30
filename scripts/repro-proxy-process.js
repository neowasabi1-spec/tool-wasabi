// Riproduce la fase PROCESS via proxy Netlify (come fa il browser su Claude).
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = process.env.APP_BASE || 'https://cute-cupcake-74bad8.netlify.app';

async function call(label, body) {
  const t = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + '/api/funnel-swap-proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    text = await res.text();
  } catch (e) { console.log(label, 'FETCH ERR', Date.now()-t, 'ms:', e.message); return; }
  console.log(`${label}: status=${res.status} time=${Date.now()-t}ms ct=${res.headers.get('content-type')} bodyLen=${JSON.stringify(body).length}`);
  console.log('   resp:', text.slice(0, 500).replace(/\s+/g, ' '));
}
(async () => {
  // job recente con 371 testi
  const { data: jobs } = await sb.from('cloning_jobs').select('id,total_texts').order('created_at', { ascending: false }).limit(3);
  const job = jobs.find(j => j.total_texts > 0);
  console.log('job', job.id, 'texts', job.total_texts, '| BASE', BASE, '\n');
  const big = 'BRIEF '.repeat(24000);   // ~144k
  const mr = 'MR '.repeat(21000);       // ~63k
  // A) process snello (no files)
  await call('A) process brief+MR    ', { phase: 'process', jobId: job.id, cloneMode: 'rewrite', batchNumber: 0, userId: '00000000-0000-0000-0000-000000000001', pageType: 'pdp', brief: big, market_research: mr });
  // B) process come browser: + brief_files/research_files grossi (proxy inietta system_kb)
  await call('B) process + files     ', { phase: 'process', jobId: job.id, cloneMode: 'rewrite', batchNumber: 0, userId: '00000000-0000-0000-0000-000000000001', pageType: 'pdp', brief: big, market_research: mr, brief_files: [{ name: 'b.txt', content: big }], research_files: [{ name: 'm.txt', content: mr }] });
})();
