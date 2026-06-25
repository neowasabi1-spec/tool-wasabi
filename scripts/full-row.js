const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const id = process.argv[2];
  const { data, error } = await sb.from('openclaw_messages').select('*').eq('id', id).single();
  if (error) { console.log('ERR', error.message); return; }
  for (const [k, v] of Object.entries(data)) {
    if (k === 'response' || k === 'user_message') {
      console.log(`${k}: [${typeof v === 'string' ? v.length : 0} chars]`);
      continue;
    }
    let s = v === null ? 'null' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (s.length > 300) s = s.slice(0, 300) + '...';
    console.log(`${k}: ${s}`);
  }
})();
