const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI');
(async () => {
  const jobId = '5fef4673-68db-4238-b52d-88cc613469b2';
  const { data: texts } = await sb.from('cloning_texts').select('original_text,tag_name').eq('job_id', jobId).limit(3000);
  const needles = ['burning feet', 'aching shoulder', 'starving nerve', 'hidden root cause', 'tingling hand', 'magnesium'];
  console.log('Job', jobId, '| testi estratti:', texts.length);
  for (const n of needles) {
    const hit = texts.filter((t) => String(t.original_text || '').toLowerCase().includes(n));
    console.log(`  "${n}" ora ESTRATTO in:`, hit.length, 'blocchi', hit.length ? '(' + hit.map(h => h.tag_name).slice(0,3).join(',') + ')' : '');
  }
})();
