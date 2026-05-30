const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  await sb.from('openclaw_messages').delete().eq('section', 'diag_test');
  const { data } = await sb
    .from('openclaw_messages')
    .select('id,status,section,target_agent,created_at,error_message')
    .order('created_at', { ascending: false })
    .limit(8);
  for (const r of data || []) {
    const age = Math.round((Date.now() - new Date(r.created_at)) / 1000);
    console.log(
      `[${r.status}] ${String(r.id).slice(0, 8)} sec=${r.section} tgt=${r.target_agent || 'null'} age=${age}s err=${(r.error_message || '').slice(0, 100)}`,
    );
  }
})();
