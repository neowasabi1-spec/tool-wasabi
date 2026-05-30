const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ 9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'.replace(/\s/g, ''),
);
const NEEDLES = ['burning feet', 'microplastic accumulation in neural tissue', 'no matter how long', 'clear brain fog'];
(async () => {
  const { data: jobs } = await sb.from('cloning_jobs').select('id,created_at,status,final_html,original_html').order('created_at', { ascending: false }).limit(4);
  for (const j of jobs) {
    const ageM = Math.round((Date.now() - new Date(j.created_at).getTime()) / 60000);
    console.log('\n==== JOB', j.id, '|', ageM + 'm |', j.status, '====');
    const fh = String(j.final_html || '');
    const oh = String(j.original_html || '');
    console.log('final_html len=', fh.length, '| original_html len=', oh.length);
    for (const n of NEEDLES) {
      console.log('  final_html has "' + n + '":', fh.toLowerCase().includes(n), '| original_html has it:', oh.toLowerCase().includes(n));
    }
    // mostra il contesto attorno a burning feet nel final_html
    const idx = fh.toLowerCase().indexOf('burning feet');
    if (idx >= 0) console.log('  >>> final_html attorno a burning feet:\n', fh.slice(Math.max(0, idx - 160), idx + 120).replace(/\s+/g, ' '));
  }
})();
