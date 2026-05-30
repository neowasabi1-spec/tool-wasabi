// scripts/find-competitor-leftovers.js
// Trova nei testi RISCRITTI dell'ultimo job i temi del competitor rimasti.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
const BAD = ['burning feet', 'aching shoulder', 'back pain', 'tingling hand', 'neuropath', 'sciatic', 'nerve', 'magnesium', 'muscle', 'foot', 'feet', 'joint', 'cramp'];
(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('id,product_name,created_at,total_texts').order('created_at', { ascending: false }).limit(1);
  const job = jobs[0];
  console.log('JOB', job.id, job.product_name);
  const { data: texts } = await sb.from('cloning_texts').select('index,original_text,new_text').eq('job_id', job.id).limit(3000);
  const hits = [];
  for (const t of texts) {
    const r = String(t.new_text || '').toLowerCase();
    const found = BAD.filter((w) => r.includes(w));
    if (found.length) hits.push({ index: t.index, found, new_text: t.new_text });
  }
  console.log(`\nBlocchi riscritti con TEMI COMPETITOR residui: ${hits.length} / ${texts.length}`);
  for (const h of hits.slice(0, 25)) {
    console.log('---  idx', h.index, '| match:', h.found.join(','));
    console.log('   ', String(h.new_text).slice(0, 240).replace(/\s+/g, ' '));
  }
})();
