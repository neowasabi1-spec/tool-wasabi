// Dump the market_research step output + project.market_research for a job.
// Usage: node scripts/dump-research.js <jobId>
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

(async () => {
  const jobId = process.argv[2];
  const q = sb.from('pipeline_jobs').select('*').order('created_at', { ascending: false }).limit(1);
  const { data, error } = jobId
    ? await sb.from('pipeline_jobs').select('*').eq('id', jobId).single()
    : await q.then((r) => ({ data: r.data && r.data[0], error: r.error }));
  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  const j = data;
  console.log(`job ${j.id}  status=${j.status}  current_step=${j.current_step}`);
  const steps = Array.isArray(j.steps) ? j.steps : [];
  for (const s of steps) {
    console.log(` - ${s.key.padEnd(16)} ${String(s.status).padEnd(10)} ${s.error ? 'ERR: ' + s.error : (s.summary || '')}`);
  }
  const mr = steps.find((s) => s.key === 'market_research');
  console.log('\n==================== MARKET RESEARCH OUTPUT ====================\n');
  console.log(mr?.output ? mr.output : '(no output yet)');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
