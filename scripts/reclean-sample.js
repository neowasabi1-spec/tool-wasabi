/* Re-clean a handful of shots once the current deploy is live, then wait.
 *
 *   node scripts/reclean-sample.js 147,79,94,95,154,140,73,83,148 [waitSeconds]
 *
 * The cleanup runs as a background function, so this waits for the deploy to
 * answer, drops the stored clean copy so the shot is genuinely redone, triggers
 * each one, and polls until nothing is left working.
 */
const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const FN = `${BASE}/.netlify/functions/inpaint-shot-background`;
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

(async () => {
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  const waitSec = Number(process.argv[3] || 300);
  if (!ids.length) return console.log('usage: node scripts/reclean-sample.js 147,79 [waitSeconds]');

  console.log(`${stamp()} waiting ${waitSec}s for the deploy to go out`);
  await sleep(waitSec * 1000);

  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shots, error } = await sb
    .from('competitor_shots')
    .select('id, project_id')
    .in('id', ids);
  if (error) { console.log('read failed:', error.message); process.exit(1); }
  if (!shots?.length) { console.log('no shots found'); process.exit(1); }

  await sb
    .from('competitor_shots')
    .update({ inpaint_status: 'pending', inpaint_error: null })
    .in('id', ids);

  for (const s of shots) {
    const r = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: s.id, projectId: s.project_id }),
    }).catch((e) => ({ status: `failed ${e.message}` }));
    console.log(`${stamp()} triggered ${s.id} -> ${r.status}`);
    await sleep(2000);
  }

  for (let i = 0; i < 90; i++) {
    await sleep(20000);
    const { data } = await sb
      .from('competitor_shots')
      .select('id, inpaint_status')
      .in('id', ids);
    const count = {};
    for (const x of data || []) count[x.inpaint_status] = (count[x.inpaint_status] || 0) + 1;
    const left = (count.pending || 0) + (count.processing || 0);
    if (i % 3 === 0) console.log(stamp(), JSON.stringify(count));
    if (!left) return console.log('SAMPLE2 COMPLETE', JSON.stringify(count));
  }
  console.log('SAMPLE2 TIMEOUT still working');
})();
