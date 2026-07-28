/* Poll competitor_shots inpaint states every 30s for up to 30 min and print
 * one summary line per tick. Used to watch AI subtitle-removal progress.
 *   node scripts/watch-inpaint.js
 */
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  let lastLine = '';
  for (let i = 0; i < 60; i++) {
    const { data, error } = await sb
      .from('competitor_shots')
      .select('id, has_text, clean_path, inpaint_status, inpaint_error')
      .limit(200);
    if (error) { console.log('read error:', error.message); await sleep(30000); continue; }
    const c = { subs: 0, cleaned: 0, pending: 0, processing: 0, error: 0 };
    for (const s of data) {
      if (s.has_text === true) c.subs++;
      if (s.clean_path) c.cleaned++;
      if (s.inpaint_status === 'pending') c.pending++;
      if (s.inpaint_status === 'processing') c.processing++;
      if (s.inpaint_status === 'error' && !s.clean_path) c.error++;
    }
    const line = `subs=${c.subs} cleaned=${c.cleaned} pending=${c.pending} processing=${c.processing} error=${c.error}`;
    if (line !== lastLine) {
      lastLine = line;
      console.log(`[${new Date().toISOString().slice(11, 19)}] CHANGE ${line}`);
      for (const s of data.filter((x) => x.inpaint_status === 'error' && !x.clean_path).slice(0, 3)) {
        console.log(`  #${s.id}: ${String(s.inpaint_error || '').slice(0, 160)}`);
      }
      if (c.subs > 0 && c.cleaned >= c.subs) { console.log('ALL_CLEANED'); break; }
      if (c.pending === 0 && c.processing === 0 && c.cleaned + c.error >= c.subs && c.cleaned > 0) {
        console.log('SETTLED');
        break;
      }
    }
    await sleep(30000);
  }
  console.log('watch finished');
})();
