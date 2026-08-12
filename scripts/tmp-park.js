const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
(async () => {
  const { data } = await sb.from('competitor_shots')
    .select('id, clean_path, inpaint_status, inpaint_error').eq('project_id', PID);
  const ids = (data||[]).filter((s) =>
    !s.clean_path &&
    (s.inpaint_status === 'processing' || s.inpaint_status === 'pending' ||
     /insufficient credit|402|429|rate|timed out|retriable|stalled/i.test(s.inpaint_error||''))
  ).map((s) => s.id);
  console.log('parking', ids.length, 'shots (awaiting Replicate credit)');
  for (let i = 0; i < ids.length; i += 50) {
    await sb.from('competitor_shots')
      .update({ inpaint_status: 'done', clean_path: null,
        inpaint_error: 'paused: Replicate credit exhausted — retriable when credit is reloaded' })
      .in('id', ids.slice(i, i + 50));
  }
  console.log('done');
})();
