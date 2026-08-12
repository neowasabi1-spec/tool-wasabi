const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
(async () => {
  const { data: vids } = await sb.from('generated_videos')
    .select('*').eq('project_id', PID).order('created_at', { ascending: false }).limit(5);
  for (const v of vids||[]) {
    console.log(`vid#${v.id} created=${v.created_at} brand=${v.brand_id} file=${v.file_path} dur=${v.duration_sec ?? v.duration ?? '?'}`);
  }
  console.log('---build jobs---');
  const { data: jobs } = await sb.from('video_build_jobs')
    .select('id, status, error, created_at, finished_at, scenes').eq('project_id', PID)
    .order('created_at', { ascending: false }).limit(5);
  for (const j of jobs||[]) {
    const nsc = Array.isArray(j.scenes) ? j.scenes.length : '?';
    console.log(`job#${j.id} ${j.status} scenes=${nsc} err=${(j.error||'').slice(0,80)} created=${j.created_at} fin=${j.finished_at}`);
  }
  if (jobs && jobs[0] && Array.isArray(jobs[0].scenes)) {
    console.log('--- newest job scenes (text lengths) ---');
    jobs[0].scenes.forEach((s,i)=>console.log(`  scene ${i}: ${String(s.text||'').length} chars | "${String(s.text||'').slice(0,50)}"`));
  }
})();
