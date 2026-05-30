const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  const { data } = await sb.from('openclaw_messages')
    .select('user_message')
    .eq('target_agent','openclaw:morfeo').eq('status','completed')
    .order('created_at',{ascending:false}).limit(1);
  const um = (data[0].user_message || '').toLowerCase();
  const phrases = ['burning feet','hidden root cause','aching shoulders','tingling hands','stabbing back'];
  for (const p of phrases) {
    console.log(`"${p}" -> ${um.includes(p) ? 'SI estratto (mandato al modello)' : 'NO non estratto'}`);
  }
}) ();
