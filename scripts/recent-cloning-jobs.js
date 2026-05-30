const { createClient } = require('@supabase/supabase-js');
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co', KEY);
function age(iso){ if(!iso) return '?'; const ms=Date.now()-new Date(iso).getTime(); if(ms<3600000) return Math.round(ms/60000)+'m'; return (ms/3600000).toFixed(1)+'h'; }
(async () => {
  // dump columns from one row first
  const { data: one } = await sb.from('cloning_jobs').select('*').order('created_at',{ascending:false}).limit(1);
  if (one && one[0]) console.log('COLUMNS:', Object.keys(one[0]).join(', '), '\n');
  const { data, error } = await sb.from('cloning_jobs')
    .select('*').order('created_at',{ascending:false}).limit(12);
  if (error) { console.error(error.message); return; }
  for (const j of data) {
    const err = j.error_message ? ' | ERR: '+String(j.error_message).slice(0,90) : '';
    console.log(`[${String(j.status).padEnd(11)}] ${String(j.id).slice(0,8)} | ${age(j.created_at)} ago | upd ${age(j.updated_at)} | total=${j.total_texts} rw=${j.rewritten_count} | ${err}`);
  }
})();
