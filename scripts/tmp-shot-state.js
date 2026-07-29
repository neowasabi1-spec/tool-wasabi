const { createClient } = require('@supabase/supabase-js');
const s = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
  { auth: { persistSession: false } },
);
(async () => {
  const ids = String(process.argv[2] || '').split(',').map(Number).filter(Boolean);
  const { data } = await s
    .from('competitor_shots')
    .select('id, inpaint_status, inpaint_error, clean_path, text_region, duration_sec')
    .in('id', ids);
  for (const r of data || []) {
    console.log(`#${r.id} ${r.inpaint_status} | region ${r.text_region} | ${r.duration_sec}s`);
    console.log(`   clean: ${r.clean_path}`);
    console.log(`   note: ${r.inpaint_error || '-'}`);
  }
})();
