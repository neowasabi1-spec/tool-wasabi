const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
(async () => {
  const { data } = await sb.from('competitor_shots')
    .select('clean_path, inpaint_status, inpaint_error').eq('project_id', PID);
  let cleaned=0, rejected=0, retriable=0, processing=0, pending=0, other=0;
  for (const s of data||[]) {
    if (s.clean_path) cleaned++;
    else if (s.inpaint_status==='processing') processing++;
    else if (s.inpaint_status==='pending') pending++;
    else if (/caption still readable/i.test(s.inpaint_error||'')) rejected++;
    else if (/retriable|timed out|stalled|insufficient|429|rate/i.test(s.inpaint_error||'')) retriable++;
    else other++;
  }
  console.log(JSON.stringify({total:data.length, cleaned, rejected, retriable, processing, pending, other}));
})();
