// Riproduce il PROCESS Claude con brief + market_research GROSSI (come il
// frontend reale), per scatenare il 500/timeout del proxy.
const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const JOB = process.argv[2] || '4161c647-af16-4e22-8250-f6dcaa08fc26';
const briefKB = parseInt(process.argv[3] || '90', 10);
const mrKB = parseInt(process.argv[4] || '90', 10);

function blob(kb, tag){ return (tag+' ').repeat(Math.round(kb*1024/(tag.length+1))); }

(async () => {
  const brief = blob(briefKB, 'BRIEF-microplastiche-cervello-NeuroFlow-dottore-Rossi-90giorni');
  const mr = blob(mrKB, 'RESEARCH-avatar-donna-45-ansia-memoria-studio-clinico');
  console.log(`JOB ${JOB.slice(0,8)} | brief=${Math.round(brief.length/1024)}KB mr=${Math.round(mr.length/1024)}KB`);
  for (let b=0;b<2;b++){
    const body = JSON.stringify({
      phase:'process', jobId:JOB, cloneMode:'rewrite', batchNumber:b, batchSize:6,
      userId:'00000000-0000-0000-0000-000000000001',
      brief, market_research: mr,
      pageType:'pdp', brief_files:[], brief_notes:'', research_files:[], research_notes:'',
    });
    console.log(`  batch ${b} bodyKB=${Math.round(body.length/1024)} ...`);
    const t=Date.now(); let res,text;
    try { res=await fetch(BASE+'/api/funnel-swap-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body}); text=await res.text(); }
    catch(e){ console.log(`  batch ${b}: FETCH ERR ${Date.now()-t}ms`, e.message); break; }
    const ms=Date.now()-t; let j=null; try{j=JSON.parse(text);}catch{}
    if(j) console.log(`  batch ${b}: status=${res.status} ${ms}ms processed=${j.batchProcessed} remaining=${j.remainingTexts} err=${j.error||''}`);
    else { console.log(`  batch ${b}: status=${res.status} ${ms}ms NON-JSON:`, text.slice(0,160).replace(/\s+/g,' ')); break; }
  }
})();
