// Re-trigger the Autopilot background sequencer for a given (or latest) job.
// Usage: node scripts/resume-pipeline.js [jobId]
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const SITE = process.env.SITE || 'https://cute-cupcake-74bad8.netlify.app';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

(async () => {
  let jobId = process.argv[2];
  if (!jobId) {
    const { data } = await sb.from('pipeline_jobs').select('id, status').order('created_at', { ascending: false }).limit(1);
    jobId = data && data[0] && data[0].id;
  }
  if (!jobId) { console.log('no job'); return; }
  console.log('resuming job', jobId, 'via', SITE);
  const res = await fetch(`${SITE}/.netlify/functions/pipeline-run-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  console.log('background fn status:', res.status);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
