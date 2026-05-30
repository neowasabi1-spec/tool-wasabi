const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, error_message')
    .order('created_at', { ascending: false })
    .limit(8);
  console.log('Now (server):', new Date().toISOString());
  for (const r of data || []) {
    console.log(`${r.created_at} | ${(r.status||'?').padEnd(11)} | ${(r.target_agent||'null').padEnd(16)} | ${r.id.slice(0,8)} ${r.error_message ? '| ERR='+r.error_message.slice(0,80) : ''}`);
  }
})();
