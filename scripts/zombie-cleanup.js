const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

// Cleans up "zombie" rows in openclaw_messages: rows stuck in
// 'processing' for too long because the worker died mid-run. Without
// cleanup, the queue route keeps reporting `worker_busy_with = <zombie>`
// and new jobs sit pending behind a worker that no longer exists.
//
// Args:
//   - prefix (8-char short id) OR full uuid: process only that row
//   - --all-stuck: process ALL rows in 'processing' older than --older-than-min
//   - --older-than-min N (default 15): threshold for --all-stuck
//
// Examples:
//   node scripts/zombie-cleanup.js 60be2e75
//   node scripts/zombie-cleanup.js --all-stuck --older-than-min 20

const args = process.argv.slice(2);
const allStuck = args.includes('--all-stuck');
const olderThanIdx = args.indexOf('--older-than-min');
const olderThanMin = olderThanIdx >= 0 ? parseInt(args[olderThanIdx + 1], 10) || 15 : 15;
const idArg = args.find((a) => !a.startsWith('--') && (a.length === 36 || a.length === 8));

(async () => {
  if (allStuck) {
    const cutoff = new Date(Date.now() - olderThanMin * 60_000).toISOString();
    const { data: stuck, error: e1 } = await sb
      .from('openclaw_messages')
      .select('id, created_at, target_agent, section')
      .eq('status', 'processing')
      .lt('created_at', cutoff);
    if (e1) { console.error('FAIL:', e1.message); process.exit(2); }
    if (!stuck || stuck.length === 0) {
      console.log(`No zombie jobs older than ${olderThanMin} min`);
      return;
    }
    console.log(`Found ${stuck.length} stuck job(s) older than ${olderThanMin} min:`);
    for (const z of stuck) console.log(`  - ${z.id} (${z.section}, ${z.target_agent || 'no-target'}, started ${z.created_at})`);
    const { data: cleaned, error: e2 } = await sb
      .from('openclaw_messages')
      .update({
        status: 'error',
        error_message: `zombie cleanup: stuck in 'processing' > ${olderThanMin} min, worker likely died`,
        completed_at: new Date().toISOString(),
      })
      .in('id', stuck.map((z) => z.id))
      .select('id');
    if (e2) { console.error('FAIL update:', e2.message); process.exit(2); }
    console.log(`Cleaned: ${cleaned?.length ?? 0}`);
    return;
  }

  if (!idArg) {
    console.error('Usage: node scripts/zombie-cleanup.js <8-char-or-uuid> | --all-stuck [--older-than-min N]');
    process.exit(1);
  }

  let fullId = idArg;
  if (idArg.length === 8) {
    const { data: matches } = await sb
      .from('openclaw_messages')
      .select('id, status')
      .like('id', `${idArg}%`);
    if (!matches || matches.length === 0) {
      console.error(`No row found with id prefix '${idArg}'`);
      process.exit(2);
    }
    if (matches.length > 1) {
      console.error(`Ambiguous prefix '${idArg}' (${matches.length} matches) — use full uuid`);
      process.exit(2);
    }
    fullId = matches[0].id;
    console.log(`Resolved '${idArg}' → ${fullId} (status=${matches[0].status})`);
  }

  const { data, error } = await sb
    .from('openclaw_messages')
    .update({
      status: 'error',
      error_message: 'zombie cleanup: worker not alive, status was stuck on processing',
      completed_at: new Date().toISOString(),
    })
    .eq('id', fullId)
    .in('status', ['pending', 'processing'])
    .select('id, status, error_message');
  if (error) { console.error('FAIL:', error.message); process.exit(2); }
  if (!data || data.length === 0) {
    console.log('NOOP: row not in pending/processing (or not found)');
  } else {
    console.log('OK cleaned:', data[0]);
  }
})();
