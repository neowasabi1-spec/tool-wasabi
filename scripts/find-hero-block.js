const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  // 1) blocco hero nel job NUOVO
  const { data: jobs } = await sb.from('cloning_jobs').select('id,created_at').order('created_at', { ascending: false }).limit(6);
  const latest = jobs[0];
  const { data: texts } = await sb.from('cloning_texts').select('index,original_text,new_text').eq('job_id', latest.id).limit(3000);
  console.log('=== JOB NUOVO', latest.id, '===');
  for (const t of texts) {
    const o = String(t.original_text || '').toLowerCase();
    if (o.includes('aches and pains') || o.includes('root cause') || o.includes('blame') || o.includes('hidden')) {
      console.log('idx', t.index);
      console.log('  ORIG:', String(t.original_text).slice(0, 220).replace(/\s+/g, ' '));
      console.log('  REWR:', String(t.new_text).slice(0, 220).replace(/\s+/g, ' '));
    }
  }
  // 2) cerca "burning feet" nei job precedenti per confermare che lo screenshot è vecchio
  console.log('\n=== Ricerca "burning feet" nei job recenti ===');
  for (const j of jobs) {
    const { data: tx } = await sb.from('cloning_texts').select('index,new_text').eq('job_id', j.id).limit(3000);
    const hit = (tx || []).filter((t) => String(t.new_text || '').toLowerCase().includes('burning feet') || String(t.new_text || '').toLowerCase().includes('aching shoulder'));
    const ageM = Math.round((Date.now() - new Date(j.created_at).getTime()) / 60000);
    console.log(j.id, '|', ageM + 'm fa | blocchi con burning feet/aching shoulders =', hit.length);
  }
})();
