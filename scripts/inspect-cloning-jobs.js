// scripts/inspect-cloning-jobs.js
// Posto GIUSTO per clone/swipe: tabelle cloning_jobs (+ cloning_texts).
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data: rows, error } = await sb
    .from('cloning_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) { console.log('ERR cloning_jobs:', error.message); return; }
  if (!rows || !rows.length) { console.log('Nessun cloning_job.'); return; }
  console.log('COLONNE cloning_jobs:', Object.keys(rows[0]).join(', '));
  console.log('');
  for (const r of rows) {
    const ageM = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
    console.log('=========================================================');
    console.log('JOB', r.id, '|', ageM + 'm fa');
    for (const k of ['status', 'phase', 'clone_mode', 'auditor', 'model', 'provider', 'url', 'product_name',
      'total_texts', 'texts_total', 'rewritten_count', 'processed_count', 'batch_number', 'batches_total',
      'error', 'error_message', 'last_error', 'coverage', 'has_blueprint']) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== '') {
        let v = r[k];
        if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '…';
        console.log('   ', k, ':', v);
      }
    }
    if (r.page_blueprint !== undefined) console.log('    page_blueprint:', r.page_blueprint ? (String(r.page_blueprint).length + ' char') : '(vuoto)');
    // conta i testi e quanti riscritti
    try {
      const { count: tot } = await sb.from('cloning_texts').select('*', { count: 'exact', head: true }).eq('job_id', r.id);
      const { count: done } = await sb.from('cloning_texts').select('*', { count: 'exact', head: true }).eq('job_id', r.id).not('rewritten_text', 'is', null);
      console.log('    cloning_texts: totali=' + tot + ', con rewritten=' + done);
    } catch (e) { console.log('    (conteggio texts fallito:', e.message, ')'); }
  }
})();
