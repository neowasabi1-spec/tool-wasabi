const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
(async () => {
  const { data } = await sb.from('cloning_jobs').select('id,page_blueprint,total_texts,created_at').order('created_at',{ascending:false}).limit(40);
  const withBp = data.filter(j => j.page_blueprint && String(j.page_blueprint).trim().length > 100);
  console.log('job con blueprint salvato:', withBp.length, '/', data.length);
  if (!withBp.length) { console.log('NESSUN job ha un blueprint salvato → conferma: il batch0 non riesce mai a generarlo+salvarlo.'); return; }
  const job = withBp[0];
  console.log('uso', String(job.id).slice(0,8), '| blueprint', String(job.page_blueprint).length, 'char | texts', job.total_texts);
  const brief = 'BRIEF microplastiche cervello NeuroFlow dottor Rossi 90gg '.repeat(1700);
  const mr = 'RESEARCH avatar donna45 ansia memoria foggy '.repeat(2000);
  console.log('brief', Math.round(brief.length/1024)+'KB mr', Math.round(mr.length/1024)+'KB');
  const body = JSON.stringify({ phase:'process', jobId: job.id, cloneMode:'rewrite', batchNumber:0, batchSize:6,
    userId:'00000000-0000-0000-0000-000000000001', brief, market_research:mr,
    pageType:'pdp', brief_files:[], brief_notes:'', research_files:[], research_notes:'' });
  const t=Date.now(); let res,text;
  try{ res=await fetch(BASE+'/api/funnel-swap-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body}); text=await res.text(); }
  catch(e){ console.log('ERR', Date.now()-t+'ms', e.message); return; }
  const ms=Date.now()-t; let j=null; try{j=JSON.parse(text);}catch{}
  console.log('batch0 (blueprint presente, 90/90):', j?`status=${res.status} ${ms}ms OK processed=${j.batchProcessed}`:`status=${res.status} ${ms}ms TIMEOUT`);
})();
