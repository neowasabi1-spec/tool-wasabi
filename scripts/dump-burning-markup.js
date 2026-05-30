const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  // HTML finale del job morfeo (contiene la frase NON riscritta)
  const { data } = await sb.from('openclaw_messages')
    .select('response').eq('target_agent','openclaw:morfeo').eq('status','completed')
    .order('created_at',{ascending:false}).limit(1);
  const html = JSON.parse(data[0].response).html || '';
  const idx = html.toLowerCase().indexOf('hidden root cause');
  if (idx < 0) { console.log('frase non trovata'); return; }
  const start = Math.max(0, idx - 400);
  console.log('=== MARKUP attorno a "hidden root cause" ===\n');
  console.log(html.slice(start, idx + 300));
})();
