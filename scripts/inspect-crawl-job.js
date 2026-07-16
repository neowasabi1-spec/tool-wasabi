const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
(async () => {
  const { data, error } = await sb
    .from('funnel_crawl_jobs')
    .select('id, status, entry_url, created_at, current_step, total_steps, result, error')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) { console.error('query error:', error.message); process.exit(1); }
  for (const j of data || []) {
    const ageM = Math.round((Date.now() - new Date(j.created_at).getTime()) / 60000);
    const steps = (j.result && j.result.steps) || [];
    console.log(`[${(j.status||'').padEnd(10)}] ${j.id} | ${ageM}m ago | ${j.current_step}/${j.total_steps} | steps=${steps.length} | ${(j.entry_url||'').slice(0,50)} | stop=${j.result?.stopDiagnostic?.reason||'-'}`);
  }
  // Inspect the most recent mounjfit job in detail
  const job = (data || []).find((j) => (j.entry_url || '').includes('mounjfit'));
  if (!job) { console.log('\nNo mounjfit job found.'); return; }
  console.log(`\n=== Detail for ${job.id} (${job.entry_url}) ===`);
  const steps = (job.result && job.result.steps) || [];
  steps.forEach((s) => {
    const h = s.html || '';
    console.log(`step ${s.stepIndex}: htmlLen=${h.length} | hasSTART=${/START MY 2026/i.test(h)} | has100Nat=${/100% Natural/i.test(h)} | hasCSSOM=${/data-captured-cssom/i.test(h)} | label="${(s.quizStepLabel||'').slice(0,40)}"`);
  });
  if (steps[0] && steps[0].html) {
    fs.writeFileSync('.tmp-job-step1.html', steps[0].html, 'utf8');
    console.log('\nwrote .tmp-job-step1.html (', steps[0].html.length, 'chars )');
  }
})();
