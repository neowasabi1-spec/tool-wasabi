const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const arg = process.argv[2];
  const { data } = await sb
    .from('openclaw_messages')
    .select('id,status,target_agent,created_at,completed_at,error_message')
    .order('created_at', { ascending: false })
    .limit(20);
  const rows = (data || []).filter((r) => !arg || String(r.id).startsWith(arg));
  for (const r of rows) {
    const age = Math.round((Date.now() - new Date(r.created_at)) / 1000);
    const dur = r.completed_at ? Math.round((new Date(r.completed_at) - new Date(r.created_at)) / 1000) + 's' : '-';
    console.log(`${String(r.id).slice(0,8)} status=${r.status} tgt=${r.target_agent || 'null'} age=${age}s dur=${dur} err=${(r.error_message || '').slice(0,120)}`);
  }
})();
