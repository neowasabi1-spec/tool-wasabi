// Estrae un job FRESCO e misura il batch 0 (cold, con generazione blueprint)
// a varie dimensioni di brief/MR, per trovare la soglia sotto i 31s.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
function blob(kb, tag){ return (tag+' ').repeat(Math.max(1,Math.round(kb*1024/(tag.length+1)))); }

async function freshJob() {
  const { data } = await sb.from('cloning_jobs').select('original_html,url,product_name').order('created_at',{ascending:false}).limit(5);
  const job = data.find(j => (j.original_html||'').length > 50000) || data[0];
  const body = JSON.stringify({ phase:'extract', url: job.url||'https://example.com', cloneMode:'rewrite',
    productName: job.product_name||'Test', productDescription:'desc', framework:'', target:'', customPrompt:'',
    targetLanguage:'en', userId:'00000000-0000-0000-0000-000000000001', renderedHtml: job.original_html||'' });
  const res = await fetch(BASE+'/api/funnel-swap-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body});
  const j = await res.json();
  return j.jobId;
}

async function batch0(jobId, kb) {
  const brief = blob(kb,'BRIEF-microplastiche-cervello-NeuroFlow-dottor-Rossi-90gg-studio');
  const mr = blob(kb,'RESEARCH-avatar-donna45-ansia-memoria-foggy-brain-clinico');
  const body = JSON.stringify({ phase:'process', jobId, cloneMode:'rewrite', batchNumber:0, batchSize:6,
    userId:'00000000-0000-0000-0000-000000000001', brief, market_research:mr,
    pageType:'pdp', brief_files:[], brief_notes:'', research_files:[], research_notes:'' });
  const t=Date.now(); let res,text;
  try{ res=await fetch(BASE+'/api/funnel-swap-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body}); text=await res.text(); }
  catch(e){ return `FETCH ERR ${Date.now()-t}ms ${e.message}`; }
  const ms=Date.now()-t; let j=null; try{j=JSON.parse(text);}catch{}
  return j ? `status=${res.status} ${ms}ms OK processed=${j.batchProcessed}` : `status=${res.status} ${ms}ms TIMEOUT/NON-JSON`;
}

(async () => {
  for (const kb of [12, 25, 40]) {
    const jobId = await freshJob();
    const r = await batch0(jobId, kb);
    console.log(`brief=${kb}KB mr=${kb}KB (job ${String(jobId).slice(0,8)}): ${r}`);
  }
})();
