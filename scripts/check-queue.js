// Quick diagnostic: query openclaw_messages and funnel_crawl_jobs for
// pending/processing rows, surface their target_agent, age, and any
// error_message. Run from repo root: `node scripts/check-queue.js`.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function ageStr(iso) {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

(async () => {
  console.log('=== openclaw_messages (pending/processing, last 20) ===');
  const { data: msgs, error: e1 } = await sb
    .from('openclaw_messages')
    .select('*')
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(20);
  if (e1) console.error('msgs error:', e1.message);
  else if (!msgs || msgs.length === 0) console.log('  (none)');
  else {
    for (const m of msgs) {
      const cols = Object.keys(m).join(',');
      if (msgs.indexOf(m) === 0) console.log(`  columns: ${cols}`);
      console.log(`  [${m.status}] id=${String(m.id).substring(0, 8)} target=${m.target_agent || '(null)'} age=${ageStr(m.created_at)}`);
    }
  }

  console.log('\n=== funnel_crawl_jobs (pending/running, last 10) ===');
  const { data: jobs, error: e2 } = await sb
    .from('funnel_crawl_jobs')
    .select('*')
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(10);
  if (e2) console.error('jobs error:', e2.message);
  else if (!jobs || jobs.length === 0) console.log('  (none)');
  else {
    for (const j of jobs) {
      if (jobs.indexOf(j) === 0) console.log(`  columns: ${Object.keys(j).join(',')}`);
      console.log(`  [${j.status}] id=${String(j.id).substring(0, 8)} target=${j.target_agent || '(null)'} url=${(j.url || '').substring(0, 50)} age=${ageStr(j.created_at)}`);
    }
  }

  console.log('\n=== openclaw_messages (last 10 of ANY status, ANY target) ===');
  const { data: recent, error: e3 } = await sb
    .from('openclaw_messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (e3) console.error('recent error:', e3.message);
  else if (!recent || recent.length === 0) console.log('  (none)');
  else {
    for (const r of recent) {
      console.log(`  [${r.status}] id=${String(r.id).substring(0, 8)} target=${r.target_agent || '(null)'} age=${ageStr(r.created_at)}`);
    }
  }
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
