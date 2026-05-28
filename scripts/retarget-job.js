// Re-route a pending openclaw_messages row from one target_agent
// to another. Used when a worker is dead and we want to flip the
// job to a healthy one without making the user redo their action.
//
//   node scripts/retarget-job.js <jobIdPrefix> <newTargetAgent>
//   node scripts/retarget-job.js fb29 openclaw:neo

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const prefix = (process.argv[2] || '').trim();
const newTarget = (process.argv[3] || '').trim();
if (!prefix || !newTarget) {
  console.error('Usage: node scripts/retarget-job.js <jobIdPrefix> <newTargetAgent>');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

(async () => {
  // id is uuid → can't LIKE on it. Fetch recent pending rows and match in JS.
  const { data: candidates, error } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, section, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { console.error('Query failed:', error.message); process.exit(1); }
  const data = (candidates || []).filter((r) => String(r.id).startsWith(prefix));
  if (!data || data.length === 0) {
    console.log(`No pending job found with id prefix '${prefix}'.`);
    return;
  }
  if (data.length > 1) {
    console.error(`Ambiguous prefix '${prefix}' — matched ${data.length} jobs. Use more chars.`);
    process.exit(1);
  }
  const job = data[0];
  console.log(`Found: id=${job.id} section=${job.section} target=${job.target_agent} created=${job.created_at}`);
  console.log(`Re-routing to target_agent=${newTarget === 'null' ? null : newTarget}...`);

  const { error: uErr } = await sb
    .from('openclaw_messages')
    .update({ target_agent: newTarget === 'null' ? null : newTarget })
    .eq('id', job.id);
  if (uErr) { console.error('Update failed:', uErr.message); process.exit(1); }
  console.log('✓ Re-routed. The new worker should claim it within a few seconds.');
})().catch((e) => { console.error('Crashed:', e.message); process.exit(1); });
