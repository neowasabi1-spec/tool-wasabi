/* Is the shot-inpaint setup ready? Checks the new columns exist and shows
 * current inpaint states.
 *   node scripts/diag-inpaint-ready.js
 */
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from('competitor_shots')
    .select('id, has_text, clean_path, inpaint_status, inpaint_error')
    .limit(100);
  if (error) {
    console.log('MIGRATION MISSING or read error:', error.message);
    return;
  }
  console.log(`migration OK — columns exist. shots checked: ${data.length}`);
  const counts = { subs: 0, clean: 0, cleaned: 0, pending: 0, processing: 0, error: 0 };
  for (const s of data) {
    if (s.has_text === true) counts.subs++; else counts.clean++;
    if (s.clean_path) counts.cleaned++;
    if (s.inpaint_status === 'pending') counts.pending++;
    if (s.inpaint_status === 'processing') counts.processing++;
    if (s.inpaint_status === 'error') counts.error++;
  }
  console.log(counts);
  const errs = data.filter((s) => s.inpaint_status === 'error').slice(0, 5);
  for (const e of errs) console.log(`  #${e.id} ERROR: ${e.inpaint_error}`);
})();
