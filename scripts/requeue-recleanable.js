/* Now that Replicate credit is back, put every recoverable subtitled shot back
 * in the cleanup queue so MiniMax reconstructs it properly.
 *
 * Targets:
 *   A) out-of-pool shots stuck in inpaint_status='error' (transient 500/503,
 *      credit 402, rate limits, timeouts). status='done' with no clean copy is a
 *      genuine "mask can't erase this" verdict and is left alone.
 *   B) the few in-pool shots still cleaned with the old opaque erase/smear —
 *      their clean_path is nulled so the opaque band is gone even if a redo fails.
 *
 * Then it fires a first small batch itself; the 5-minute video-pipeline cron
 * drains the rest at a rate Replicate accepts.
 *
 *   node scripts/requeue-recleanable.js            # reset + fire first batch
 *   node scripts/requeue-recleanable.js --dry      # just show what it would do
 */
const { createClient } = require('@supabase/supabase-js');

const SITE = process.env.SITE_URL || 'https://cute-cupcake-74bad8.netlify.app';
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const OPAQUE_IN_POOL = [118, 123, 137];
const FIRST_BATCH = 6;
const dry = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const s = createClient(URL, KEY, { auth: { persistSession: false } });

  // A) every subtitled shot stuck in error with no clean copy.
  const { data: errRows, error: e1 } = await s
    .from('competitor_shots')
    .select('id, project_id')
    .eq('has_text', true)
    .eq('inpaint_status', 'error')
    .is('clean_path', null);
  if (e1) return console.log('read A failed:', e1.message);
  const errIds = errRows.map((r) => r.id);

  const { data: opaqueRows } = await s
    .from('competitor_shots')
    .select('id, project_id')
    .in('id', OPAQUE_IN_POOL);

  console.log(`recoverable error shots: ${errIds.length}`);
  console.log(`opaque in-pool shots to redo: ${OPAQUE_IN_POOL.join(',')}`);
  if (dry) return console.log('(dry run — nothing changed)');

  if (errIds.length) {
    for (let i = 0; i < errIds.length; i += 200) {
      await s.from('competitor_shots')
        .update({ inpaint_status: 'pending', inpaint_error: null })
        .in('id', errIds.slice(i, i + 200));
    }
  }
  await s.from('competitor_shots')
    .update({ inpaint_status: 'pending', inpaint_error: null, clean_path: null })
    .in('id', OPAQUE_IN_POOL);

  const { count } = await s
    .from('competitor_shots')
    .select('id', { count: 'exact', head: true })
    .eq('inpaint_status', 'pending');
  console.log(`now pending in queue: ${count}`);

  // Fire a first batch ourselves so the user sees movement immediately; the
  // cron picks up the rest 6 at a time every 5 minutes.
  const first = [...OPAQUE_IN_POOL, ...errIds].slice(0, FIRST_BATCH);
  const rows = [...(opaqueRows || []), ...errRows].filter((r) => first.includes(r.id));
  for (const r of rows) {
    const body = { shotId: r.id };
    if (r.project_id) body.projectId = r.project_id;
    const resp = await fetch(`${SITE}/.netlify/functions/inpaint-shot-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch((err) => ({ status: `failed ${err.message}` }));
    console.log(`fired #${r.id} -> ${resp.status}`);
    await sleep(2000);
  }
  console.log('first batch fired; the 5-min cron drains the rest.');
})();
