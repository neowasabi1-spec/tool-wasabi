// Test E2E reale: prende un job VERO e gira alcuni batch di process via proxy
// con batchSize 6 (come fa ora il frontend deployato). Misura tempi e rewrites.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
(async () => {
  // job VERO recente (brief grosso, processing)
  const { data: jobs } = await sb.from('cloning_jobs').select('id,total_texts,product_description,status,created_at').order('created_at', { ascending: false }).limit(10);
  const job = jobs.find(j => String(j.product_description||'').length > 100000 && j.total_texts > 0);
  const brief = String(job.product_description || '').slice(0, 90000);
  console.log('JOB VERO', job.id, '| texts', job.total_texts, '| status', job.status, '| briefLen', brief.length, '\n');

  for (let b = 0; b < 4; b++) {
    const t = Date.now();
    let res, text;
    try {
      res = await fetch(BASE + '/api/funnel-swap-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'process', jobId: job.id, cloneMode: 'rewrite', batchNumber: b, batchSize: 6, userId: '00000000-0000-0000-0000-000000000001', pageType: 'pdp', brief, market_research: '' }),
      });
      text = await res.text();
    } catch (e) { console.log(`batch ${b}: FETCH ERR ${Date.now()-t}ms`, e.message); break; }
    let p = null; try { p = JSON.parse(text); } catch {}
    const ms = Date.now() - t;
    if (!p) { console.log(`batch ${b}: status=${res.status} ${ms}ms NON-JSON:`, text.slice(0,140).replace(/\s+/g,' ')); break; }
    const sample = (p.rewrites && p.rewrites[0]) ? `${String(p.rewrites[0].original||'').slice(0,40)} => ${String(p.rewrites[0].rewritten||'').slice(0,50)}` : '(no rewrites)';
    console.log(`batch ${b}: status=${res.status} ${ms}ms | processed=${p.batchProcessed} remaining=${p.remainingTexts} phase=${p.phase}`);
    console.log('     es:', sample);
    if (p.phase === 'completed') { console.log('>>> COMPLETATO'); break; }
  }
})();
