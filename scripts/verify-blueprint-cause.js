const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const JOB = process.argv[2] || '99adc443';
(async () => {
  const { data } = await sb.from('cloning_jobs').select('id,page_blueprint,status').like('id', JOB+'%').limit(1);
  const job = data && data[0];
  console.log('job', JOB, '| blueprint salvato?', job && job.page_blueprint ? `SI (${String(job.page_blueprint).length} char)` : 'NO');
  if (!job) return;
  // retry batch 0 piccolo: se ora il blueprint c'è, dovrebbe essere veloce
  const brief = 'BRIEF microplastiche cervello NeuroFlow '.repeat(200);
  const body = JSON.stringify({ phase:'process', jobId: job.id, cloneMode:'rewrite', batchNumber:0, batchSize:6,
    userId:'00000000-0000-0000-0000-000000000001', brief, market_research:'',
    pageType:'pdp', brief_files:[], brief_notes:'', research_files:[], research_notes:'' });
  const t=Date.now(); let res,text;
  try{ res=await fetch(BASE+'/api/funnel-swap-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body}); text=await res.text(); }
  catch(e){ console.log('retry batch0: FETCH ERR', Date.now()-t+'ms', e.message); return; }
  const ms=Date.now()-t; let j=null; try{j=JSON.parse(text);}catch{}
  console.log('retry batch0 (blueprint ora presente):', j?`status=${res.status} ${ms}ms OK processed=${j.batchProcessed}`:`status=${res.status} ${ms}ms TIMEOUT`);
})();
