// Same as inspect-jobs.js but ALL target_agents (claude path doesn't use this
// queue but neo/morfeo paths do). Print short summary of last 20 messages.
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data, error } = await sb
    .from('openclaw_messages')
    .select('id, status, target_agent, created_at, completed_at, error_message, user_message')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { console.error(error); process.exit(1); }
  for (const m of data || []) {
    const um = m.user_message || '';
    const action = (um.match(/"action"\s*:\s*"([^"]+)/) || [])[1] || '?';
    const urlMatch = um.match(/sourceUrl"?\s*:\s*"([^"]+)/);
    const url = urlMatch ? urlMatch[1] : '';
    const ageM = Math.round((Date.now() - new Date(m.created_at).getTime()) / 60000);
    const dur = m.completed_at
      ? Math.round((new Date(m.completed_at).getTime() - new Date(m.created_at).getTime()) / 1000) + 's'
      : '-';
    const err = m.error_message ? ` | ERR: ${String(m.error_message).slice(0, 100)}` : '';
    console.log(`[${(m.status || '?').padEnd(11)}] ${m.id.slice(0,8)} | ${ageM}m ago | dur=${dur} | tgt=${m.target_agent || 'null'} | ${action} | ${url.slice(0, 60)}${err}`);
  }
})();
