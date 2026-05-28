// Injects a tiny test job into openclaw_messages targeted at the
// agent given on the CLI (default 'openclaw:neo') and watches for
// it to flip from 'pending' → 'processing' → 'completed'. Used to
// answer the question "is this worker actually polling right now?".
//
//   node scripts/ping-worker.js                  # → openclaw:neo
//   node scripts/ping-worker.js openclaw:morfeo  # → Morfeo
//   node scripts/ping-worker.js null             # → no target (legacy)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const argTarget = (process.argv[2] || 'openclaw:neo').trim();
const targetAgent = argTarget === 'null' ? null : argTarget;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

(async () => {
  console.log(`Inserting ping job for target_agent=${targetAgent || '(null)'}...`);
  const { data: ins, error: iErr } = await sb
    .from('openclaw_messages')
    .insert({
      user_message: 'ping-test: please reply with "pong"',
      system_prompt: 'You are a test responder. Reply with one word: pong.',
      section: 'ping_test',
      status: 'pending',
      target_agent: targetAgent,
    })
    .select('id, created_at')
    .single();
  if (iErr) { console.error('Insert failed:', iErr.message); process.exit(1); }
  const id = ins.id;
  console.log(`✓ inserted id=${String(id).slice(0, 8)} at ${ins.created_at}`);
  console.log('Watching for claim... (max 20s, polling every 1s)');

  const start = Date.now();
  let lastStatus = 'pending';
  while (Date.now() - start < 20_000) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: row, error: rErr } = await sb
      .from('openclaw_messages')
      .select('id, status, error_message, response')
      .eq('id', id)
      .single();
    if (rErr) { console.error('Read failed:', rErr.message); continue; }
    if (row.status !== lastStatus) {
      const dt = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  [+${dt}s] status: ${lastStatus} → ${row.status}`);
      lastStatus = row.status;
      if (row.status === 'completed' || row.status === 'error' || row.status === 'failed') {
        console.log(`  response: ${(row.response || '').slice(0, 80)}`);
        console.log(`  error_message: ${(row.error_message || '').slice(0, 120)}`);
        break;
      }
    }
  }
  if (lastStatus === 'pending') {
    console.log(`\n✗ Worker for ${targetAgent || '(any)'} did NOT pick up the ping in 20s. Worker is not polling.`);
  } else {
    console.log(`\n✓ Worker for ${targetAgent || '(any)'} is alive (final status: ${lastStatus}).`);
  }

  // Cleanup the test row.
  await sb.from('openclaw_messages').delete().eq('id', id);
})().catch((e) => { console.error('Crashed:', e.message); process.exit(1); });
