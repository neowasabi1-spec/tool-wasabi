// Dump a single step's full output for a job.
// Usage: node scripts/dump-step.js <jobId> <stepKey>
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
(async () => {
  const jobId = process.argv[2];
  const stepKey = process.argv[3] || 'competitor';
  const { data, error } = await sb.from('pipeline_jobs').select('steps').eq('id', jobId).single();
  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  const step = (data.steps || []).find((s) => s.key === stepKey);
  console.log(`=== ${stepKey} ===`);
  console.log('summary:', step?.summary || '(none)');
  console.log('\noutput:\n' + (step?.output || '(none)'));
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
