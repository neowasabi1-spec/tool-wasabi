// Dump the stopDiagnostic inventory of a stuck quiz job to see WHAT
// element the clicker failed to advance past.
// Run: node scripts/inspect-quiz-jobs.js [urlSubstring]
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const urlFilter = process.argv[2] || 'weight-loss';

(async () => {
  const { data, error } = await sb
    .from('funnel_crawl_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) { console.error(error.message); process.exit(1); }

  const job = (data || []).find((r) => {
    const p = r.params || {};
    const u = p.entryUrl || r.entry_url || '';
    const diag = (r.result || {}).stopDiagnostic || {};
    return u.includes(urlFilter) && diag.reason === 'no_advance_button';
  });
  if (!job) { console.log('no stuck job found for', urlFilter); process.exit(0); }

  const res = job.result || {};
  const diag = res.stopDiagnostic || {};
  console.log('JOB', job.id, '| url=', (job.params || {}).entryUrl);
  console.log('captured steps:', (res.steps || []).length);
  for (const s of res.steps || []) {
    console.log(`  step ${s.stepIndex}: "${(s.title || '').slice(0, 50)}" url=${(s.url || '').slice(0, 60)}`);
  }
  console.log('\nSTOP at step', diag.atStep, 'url=', diag.url, 'title=', diag.title);
  console.log('label=', diag.label);
  console.log('\nDOM INVENTORY at stuck page:');
  for (const it of diag.inventory || []) {
    console.log(`  [${it.tag}] "${(it.text || '').slice(0, 50)}" ${it.w}x${it.h} ${it.disabled ? '(disabled)' : ''} class="${(it.cls || '').slice(0, 70)}"`);
  }
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
