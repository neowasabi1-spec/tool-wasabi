// Diagnostic: dump the latest pipeline_jobs rows (Autopilot).
// Run from repo root: `node scripts/inspect-pipeline.js`
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function age(iso) {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

(async () => {
  const { data, error } = await sb
    .from('pipeline_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  if (!data || !data.length) { console.log('(no pipeline_jobs rows)'); return; }
  for (const j of data) {
    console.log('============================================');
    console.log(`job ${j.id}`);
    console.log(`  status=${j.status}  current_step=${j.current_step}  created=${age(j.created_at)} updated=${age(j.updated_at)}`);
    console.log(`  project_id=${j.project_id}`);
    console.log(`  input=${JSON.stringify(j.input)}`);
    if (j.error) console.log(`  job.error=${j.error}`);
    const steps = Array.isArray(j.steps) ? j.steps : [];
    for (const s of steps) {
      console.log(`   - ${s.key.padEnd(16)} ${String(s.status).padEnd(10)} ${s.error ? 'ERR: ' + s.error : (s.summary || '')}`);
    }
  }
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
