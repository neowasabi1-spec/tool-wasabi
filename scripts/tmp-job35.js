const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
(async () => {
  const { data: jobs } = await sb.from('video_build_jobs')
    .select('*').in('id', [34, 35]);
  for (const j of jobs||[]) {
    console.log(`job#${j.id} status=${j.status} brand=${j.brand_id} ad=${j.ad_id} result_id=${j.result_id ?? 'null'} fin=${j.finished_at}`);
  }
  const { data: vids } = await sb.from('generated_videos')
    .select('id, brand_id, ad_id, created_at, duration_sec').order('id', { ascending: false }).limit(4);
  console.log('newest generated_videos:');
  for (const v of vids||[]) console.log(`  vid#${v.id} brand=${v.brand_id} ad=${v.ad_id} dur=${v.duration_sec} ${v.created_at}`);
})();
