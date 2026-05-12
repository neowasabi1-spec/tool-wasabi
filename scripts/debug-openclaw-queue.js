/**
 * Debug helper: peek at the openclaw_messages queue and verify the
 * routing column is in place + worker(s) are processing.
 *
 *   node scripts/debug-openclaw-queue.js
 *
 * Reports:
 *   - column count of openclaw_messages (so we see if target_agent
 *     migration ran).
 *   - last 10 messages: status, section, target_agent, age, latency.
 *   - count of pending messages by target_agent bucket.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL
  || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function ago(iso) {
  if (!iso) return '–';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / 86400_000)}d`;
}

(async () => {
  console.log('═══════════════════════════════════════════');
  console.log(' OpenClaw queue diagnostic');
  console.log('═══════════════════════════════════════════');

  // 1. Schema check — does target_agent exist?
  const { data: probe, error: probeErr } = await supabase
    .from('openclaw_messages')
    .select('id, target_agent')
    .limit(1);
  if (probeErr) {
    if (probeErr.message.includes('target_agent')) {
      console.log('❌ Migration NOT applied: column "target_agent" missing.');
      console.log('   Run supabase-migration-openclaw-target-agent.sql in the Supabase SQL editor.');
    } else {
      console.log('❌ Probe failed:', probeErr.message);
    }
    process.exit(1);
  }
  console.log('✓ target_agent column present');

  // 2. Last 10 messages
  const { data: recent, error: recentErr } = await supabase
    .from('openclaw_messages')
    .select('id, status, section, target_agent, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (recentErr) {
    console.log('❌ Recent fetch failed:', recentErr.message);
    process.exit(1);
  }

  console.log('\nLast 10 messages (newest first):');
  console.log(
    'STATUS      SECTION              AGENT             AGE    LATENCY',
  );
  console.log(
    '──────────  ───────────────────  ────────────────  ─────  ───────',
  );
  for (const r of recent) {
    const status = (r.status || '').padEnd(10);
    const section = (r.section || '').padEnd(19).slice(0, 19);
    const agent = (r.target_agent || '(none)').padEnd(16).slice(0, 16);
    const age = ago(r.created_at).padEnd(5);
    const latency =
      r.completed_at && r.created_at
        ? `${Math.round(
            (new Date(r.completed_at).getTime() -
              new Date(r.created_at).getTime()) /
              1000,
          )}s`
        : '–';
    console.log(`${status}  ${section}  ${agent}  ${age}  ${latency}`);
  }

  // 3. Pending breakdown
  const { data: pending } = await supabase
    .from('openclaw_messages')
    .select('id, target_agent, created_at, section')
    .eq('status', 'pending')
    .order('created_at');
  if (pending && pending.length > 0) {
    console.log(`\n⚠ ${pending.length} pending message(s):`);
    const buckets = {};
    for (const p of pending) {
      const k = p.target_agent || '(any/legacy)';
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(p);
    }
    for (const [agent, items] of Object.entries(buckets)) {
      console.log(`  • ${agent}: ${items.length} (oldest ${ago(items[0].created_at)})`);
    }
    console.log(
      '\n  → If items are piling up under a specific agent, that worker is offline / not consuming.',
    );
  } else {
    console.log('\n✓ Queue empty (no pending messages)');
  }

  // 4. Last completed checkpoint_audit per agent (proves who's alive)
  const { data: lastCp } = await supabase
    .from('openclaw_messages')
    .select('target_agent, completed_at')
    .eq('section', 'checkpoint_audit')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(20);
  if (lastCp && lastCp.length > 0) {
    const byAgent = {};
    for (const r of lastCp) {
      const k = r.target_agent || '(none)';
      if (!byAgent[k]) byAgent[k] = r.completed_at;
    }
    console.log('\nLast completed checkpoint_audit per agent:');
    for (const [agent, ts] of Object.entries(byAgent)) {
      console.log(`  • ${agent}: ${ago(ts)} ago`);
    }
  } else {
    console.log(
      '\nℹ No checkpoint_audit jobs ever completed yet. Run one from the UI to test.',
    );
  }

  console.log('\n═══════════════════════════════════════════');
})().catch((e) => {
  console.error('Crashed:', e);
  process.exit(1);
});
