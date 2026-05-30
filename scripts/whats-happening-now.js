const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
function age(iso){ if(!iso) return '?'; const ms=Date.now()-new Date(iso).getTime(); if(ms<60000) return Math.round(ms/1000)+'s'; if(ms<3600000) return Math.round(ms/60000)+'m'; return (ms/3600000).toFixed(1)+'h'; }
(async () => {
  console.log('==== openclaw_messages (ultimi 8, qualsiasi stato) ====');
  const { data: msgs } = await sb.from('openclaw_messages').select('id,status,target_agent,created_at,completed_at,error_message').order('created_at',{ascending:false}).limit(8);
  for (const m of msgs||[]) {
    console.log(`[${String(m.status).padEnd(10)}] ${String(m.id).slice(0,8)} | ${m.target_agent||'(null)'} | creato ${age(m.created_at)} fa | fine ${m.completed_at?age(m.completed_at)+' fa':'-'}${m.error_message?' | ERR: '+String(m.error_message).slice(0,70):''}`);
  }
  console.log('\n==== cloning_jobs (ultimi 8) ====');
  const { data: jobs } = await sb.from('cloning_jobs').select('id,status,total_texts,created_at,completed_at,page_blueprint').order('created_at',{ascending:false}).limit(8);
  for (const j of jobs||[]) {
    console.log(`[${String(j.status).padEnd(11)}] ${String(j.id).slice(0,8)} | creato ${age(j.created_at)} fa | testi ${j.total_texts} | blueprint ${j.page_blueprint?'SI':'no'} | fine ${j.completed_at?age(j.completed_at)+' fa':'-'}`);
  }
})();
