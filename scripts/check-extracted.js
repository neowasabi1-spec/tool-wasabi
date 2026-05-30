const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('id').order('created_at', { ascending: false }).limit(1);
  const { data: texts } = await sb.from('cloning_texts').select('index,original_text,new_text').eq('job_id', jobs[0].id).limit(3000);
  const needle = ['hidden root cause', 'burning feet', 'aching shoulder', 'tingling hand', 'pain that never stops'];
  console.log('Cerco i frammenti del competitor tra i TESTI ESTRATTI (original_text):');
  for (const n of needle) {
    const hit = texts.filter((t) => String(t.original_text || '').toLowerCase().includes(n));
    console.log('  "' + n + '" presente in original_text:', hit.length, 'blocchi', hit.length ? '-> idx ' + hit.map((h) => h.index).join(',') : '(MAI ESTRATTO)');
  }
})();
