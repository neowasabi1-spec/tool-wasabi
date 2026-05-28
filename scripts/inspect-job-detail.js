// Deep dive on a single openclaw_messages row. Pass the id (or its 8-char prefix).
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node inspect-job-detail.js <id>'); process.exit(1); }
  // id is uuid — fetch the most recent ones and match by prefix in JS.
  const { data: rows, error } = await sb
    .from('openclaw_messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { console.error(error); process.exit(1); }
  const data = (rows || []).filter((r) => String(r.id).startsWith(arg));
  if (!data || data.length === 0) { console.log('no row'); return; }
  const row = data[0];
  console.log('═'.repeat(78));
  console.log('id        :', row.id);
  console.log('status    :', row.status);
  console.log('target    :', row.target_agent);
  console.log('created   :', row.created_at);
  console.log('completed :', row.completed_at);
  console.log('error     :', row.error_message);
  console.log('─'.repeat(78));
  console.log('--- user_message (raw) ---');
  let um = row.user_message;
  try { const parsed = JSON.parse(um); um = JSON.stringify(parsed, (k, v) => typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + `…(${v.length}chars)` : v, 2); } catch {/* not json */}
  console.log(typeof um === 'string' ? um.slice(0, 4000) : um);
  console.log('─'.repeat(78));
  console.log('--- other top-level keys ---');
  for (const k of Object.keys(row)) {
    if (['id','status','target_agent','created_at','completed_at','error_message','user_message'].includes(k)) continue;
    const v = row[k];
    if (v == null) { console.log(`  ${k}: <null>`); continue; }
    if (typeof v === 'string') {
      console.log(`  ${k}: string(${v.length}) ${v.slice(0, 200).replace(/\n/g, ' ')}${v.length > 200 ? '…' : ''}`);
    } else if (typeof v === 'object') {
      let s = '';
      try { s = JSON.stringify(v); } catch { s = '[unstringifiable]'; }
      console.log(`  ${k}: ${typeof v}(${s.length}) ${s.slice(0, 200)}${s.length > 200 ? '…' : ''}`);
    } else {
      console.log(`  ${k}:`, v);
    }
  }
})();
