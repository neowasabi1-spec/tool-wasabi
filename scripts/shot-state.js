/* What the cleanup decided for a shot: status, whether a cleaned copy exists,
 * and the note it left. A shot with no cleaned copy is deliberately out of the
 * footage pool, which is the outcome for captions the remover cannot erase.
 *
 *   node scripts/shot-state.js 148,147
 */
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return console.log('usage: node scripts/shot-state.js 148,147');
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await s
    .from('competitor_shots')
    .select('id, inpaint_status, inpaint_error, clean_path, has_text, section, duration_sec')
    .in('id', ids);
  if (error) return console.log('read failed:', error.message);
  for (const r of data || []) {
    console.log(`#${r.id} ${r.inpaint_status} | ${r.section} | ${r.duration_sec}s | ` +
      `${r.clean_path ? 'in the pool' : 'OUT of the pool'}`);
    if (r.inpaint_error) console.log(`   note: ${r.inpaint_error}`);
  }
})();
