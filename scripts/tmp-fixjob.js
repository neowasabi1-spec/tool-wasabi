const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI'
);
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
(async () => {
  // Mark any build job stuck in processing/pending for this project as errored,
  // so the modal stops showing "Building..." forever.
  const { data } = await sb.from('video_build_jobs')
    .update({ status: 'error', error: 'stalled: background function exceeded the 15-min limit (rebuild)', finished_at: new Date().toISOString() })
    .eq('project_id', PID).in('status', ['processing', 'pending']).select('id, status');
  console.log('reset jobs:', JSON.stringify(data));
})();
