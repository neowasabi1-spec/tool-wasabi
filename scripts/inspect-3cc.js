const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  const { data } = await sb.from('openclaw_messages').select('*').eq('id', '3cc3aea6-... ').limit(1);
  const { data: d2 } = await sb.from('openclaw_messages').select('*').like('id', '3cc3aea6%').limit(1);
  const m = (d2 && d2[0]) || (data && data[0]);
  if (!m) { console.log('not found'); return; }
  console.log('id        :', m.id);
  console.log('status    :', m.status);
  console.log('target    :', m.target_agent);
  console.log('created   :', m.created_at);
  console.log('completed :', m.completed_at);
  console.log('error     :', m.error_message);
  const um = String(m.user_message || '');
  console.log('action    :', (um.match(/action"\s*:\s*"([^"]+)/) || [])[1]);
  console.log('sourceUrl :', (um.match(/sourceUrl"\s*:\s*"([^"]+)/) || [])[1]);
  console.log('auditor   :', (um.match(/auditor"\s*:\s*"([^"]+)/) || [])[1]);
  console.log('user_msg_len:', um.length);
  console.log('response  :', String(m.response || '').slice(0, 300));
})();
