const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
// SOLO i job creati dai miei script di test in questa sessione:
const MINE = ['95ebc3b3-f0b3-4565-9175-54da80cf6ae5','9493cd61-f43a-4b54-870e-56f77aaa0a24','bb603fb7-0b8c-47cd-b817-f981c48e4f49','5fef4673-68db-4238-b52d-88cc613469b2'];
(async () => {
  for (const id of MINE) {
    const dt = await sb.from('cloning_texts').delete().eq('job_id', id);
    const dj = await sb.from('cloning_jobs').delete().eq('id', id);
    console.log(id, '| texts del:', dt.error ? dt.error.message : 'ok', '| job del:', dj.error ? dj.error.message : 'ok');
  }
})();
