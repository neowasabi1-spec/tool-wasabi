/* Wait until the inpaint background function deploy is live (GET returns the
 * expected version marker), then re-queue all errored/stale subtitled shots
 * and trigger the function for each. One-shot orchestration after a fix.
 *   node scripts/requeue-inpaint-when-live.js
 */
const { createClient } = require('@supabase/supabase-js');

const BASE = 'https://cute-cupcake-74bad8.netlify.app';
const FN = `${BASE}/.netlify/functions/inpaint-shot-background`;
const EXPECT_VERSION = 'v3-twostage-noscale2ref';
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Wait for deploy (max 25 min).
  let live = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(FN, { method: 'GET' });
      const txt = (await r.text()).trim();
      console.log(`[${new Date().toISOString().slice(11, 19)}] GET -> ${r.status} "${txt.slice(0, 60)}"`);
      if (r.ok && txt === EXPECT_VERSION) { live = true; break; }
    } catch (e) {
      console.log('GET failed:', e.message);
    }
    await sleep(30000);
  }
  if (!live) { console.log('DEPLOY_NOT_LIVE — giving up'); process.exit(1); }
  console.log('DEPLOY_LIVE');

  // 2. Re-queue errored subtitled shots (and stale processing ones).
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: shots, error } = await sb
    .from('competitor_shots')
    .select('id, project_id, inpaint_status, clean_path, has_text')
    .eq('has_text', true);
  if (error) { console.log('read error:', error.message); process.exit(1); }
  const targets = (shots || []).filter(
    (s) => s.inpaint_status === 'error' || s.inpaint_status === 'processing',
  );
  if (!targets.length) { console.log('NOTHING_TO_REQUEUE'); process.exit(0); }
  const ids = targets.map((s) => s.id);
  const { error: upErr } = await sb
    .from('competitor_shots')
    .update({ inpaint_status: 'pending', inpaint_error: null })
    .in('id', ids);
  if (upErr) { console.log('requeue error:', upErr.message); process.exit(1); }
  console.log('REQUEUED', ids.join(','));

  // 3. Trigger the background function per shot.
  for (const s of targets) {
    try {
      const r = await fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: s.id, projectId: s.project_id }),
      });
      console.log('TRIGGERED shot', s.id, '->', r.status);
    } catch (e) {
      console.log('trigger failed for shot', s.id, ':', e.message);
    }
    await sleep(1500);
  }
  console.log('ALL_TRIGGERED');
})();
