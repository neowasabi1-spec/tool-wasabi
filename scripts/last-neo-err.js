const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb
    .from('openclaw_messages')
    .select('created_at,error_message')
    .eq('target_agent', 'openclaw:neo')
    .eq('status', 'error')
    .order('created_at', { ascending: false })
    .limit(1);
  console.log(data[0].created_at);
  console.log('---FULL ERROR---');
  console.log(data[0].error_message);
})();
