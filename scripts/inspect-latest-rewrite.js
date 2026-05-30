// scripts/inspect-latest-rewrite.js
// Ultimo cloning_job: blueprint + campioni di testo originale vs riscritto.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('*').order('created_at', { ascending: false }).limit(1);
  const job = jobs && jobs[0];
  if (!job) { console.log('no job'); return; }
  const ageM = Math.round((Date.now() - new Date(job.created_at).getTime()) / 60000);
  console.log('JOB', job.id, '| status=', job.status, '|', ageM + 'm fa', '| total_texts=', job.total_texts);
  console.log('product_name=', job.product_name);
  console.log('\n===== PAGE BLUEPRINT (' + (job.page_blueprint ? String(job.page_blueprint).length : 0) + ' char) =====');
  console.log(job.page_blueprint || '(vuoto)');

  const { data: texts, error } = await sb.from('cloning_texts').select('*').eq('job_id', job.id).order('id', { ascending: true }).limit(3000);
  if (error) { console.log('ERR texts:', error.message); return; }
  if (!texts || !texts.length) { console.log('\nnessun cloning_text'); return; }
  console.log('\nCOLONNE cloning_texts:', Object.keys(texts[0]).join(', '));

  // individua la colonna del testo riscritto e quella dell'originale
  const keys = Object.keys(texts[0]);
  const rewKey = ['rewritten_text', 'rewritten', 'new_text', 'text_new', 'rewrite', 'result_text'].find((k) => keys.includes(k));
  const origKey = ['original_text', 'text', 'original', 'source_text', 'text_original'].find((k) => keys.includes(k));
  console.log('-> rewKey=', rewKey, '| origKey=', origKey);

  let done = 0, changed = 0;
  for (const t of texts) {
    const r = rewKey ? t[rewKey] : null;
    const o = origKey ? t[origKey] : null;
    if (r && String(r).trim()) done++;
    if (r && o && String(r).trim() && String(r).trim() !== String(o).trim()) changed++;
  }
  console.log(`\nTOTALE=${texts.length} | con rewritten=${done} | effettivamente diversi dall'originale=${changed}`);

  console.log('\n===== PRIMI 8 BLOCCHI (orig -> riscritto) =====');
  for (const t of texts.slice(0, 8)) {
    const o = origKey ? String(t[origKey] || '') : '';
    const r = rewKey ? String(t[rewKey] || '') : '';
    console.log('---');
    console.log('ORIG:', o.slice(0, 180).replace(/\s+/g, ' '));
    console.log('REWR:', r ? r.slice(0, 180).replace(/\s+/g, ' ') : '(vuoto)');
  }
})();
