const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
const BASE = 'https://cute-cupcake-74bad8.netlify.app';

async function tryEnqueue(htmlMB, kbMB) {
  const html = 'x'.repeat(Math.round(htmlMB*1024*1024));
  const prompts = [{ title:'kb', content: 'y'.repeat(Math.round(kbMB*1024*1024)) }];
  const swipePayload = { action:'swipe_landing_local', sourceUrl:'https://example.com/test',
    product:{name:'T',description:'d'}, tone:'professional', language:'en',
    knowledge:{ prompts, project:{name:'T',brief:null,market_research:null,notes:null} }, html };
  const body = JSON.stringify({ section:'swipe_job', message: JSON.stringify(swipePayload), targetAgent:'openclaw:morfeo' });
  const t=Date.now(); let res,text;
  try{ res=await fetch(BASE+'/api/openclaw/queue',{method:'POST',headers:{'Content-Type':'application/json'},body}); text=await res.text(); }
  catch(e){ console.log(`html=${htmlMB}MB kb=${kbMB}MB (body=${(body.length/1048576).toFixed(1)}MB): FETCH ERR ${Date.now()-t}ms ${e.message}`); return; }
  let j=null; try{j=JSON.parse(text);}catch{}
  console.log(`html=${htmlMB}MB kb=${kbMB}MB (body=${(body.length/1048576).toFixed(1)}MB): status=${res.status} ${Date.now()-t}ms ${j?('id '+(j.id||j.error)):('NON-JSON: '+text.slice(0,80).replace(/\s+/g,' '))}`);
  if(j&&j.id) await fetch(`${BASE}/api/openclaw/queue?id=${j.id}&reason=test`,{method:'DELETE'}).catch(()=>{});
}
(async () => {
  await tryEnqueue(1.6, 0.5);
  await tryEnqueue(1.6, 2);
  await tryEnqueue(1.6, 4);
  await tryEnqueue(3, 4);
})();
