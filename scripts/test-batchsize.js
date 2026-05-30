const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';

async function proc(label, jobId, batchSize, extra) {
  const t = Date.now();
  let res, text;
  const body = { phase: 'process', jobId, cloneMode: 'rewrite', batchNumber: 0, batchSize, userId: '00000000-0000-0000-0000-000000000001', pageType: 'pdp', brief: 'B'.repeat(90000), market_research: 'M'.repeat(60000), ...extra };
  try { res = await fetch(BASE + '/api/funnel-swap-proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); text = await res.text(); }
  catch (e) { console.log(label, 'ERR', Date.now()-t, 'ms', e.message); return; }
  console.log(`${label}: status=${res.status} time=${Date.now()-t}ms`);
  console.log('   ', text.slice(0, 200).replace(/\s+/g, ' '));
}
(async () => {
  // recent jobs
  const { data: jobs } = await sb.from('cloning_jobs').select('id,status,total_texts,created_at').order('created_at', { ascending: false }).limit(6);
  console.log('=== JOB RECENTI ===');
  for (const j of jobs) console.log(' ', j.id, '|', j.status, '| texts', j.total_texts, '|', Math.round((Date.now()-new Date(j.created_at))/60000)+'m fa');
  const job = jobs.find(j => j.total_texts > 0);
  console.log('\nuso job', job.id, '\n');
  await proc('batchSize=6 (no kb) ', job.id, 6);
  await proc('batchSize=3 (no kb) ', job.id, 3);
})();
