const { createClient } = require('@supabase/supabase-js');
const URL_SB = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_SB, KEY);
(async () => {
  const jobId = process.argv[2];
  const projectId = process.argv[3] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { data: job } = await sb.from('pipeline_jobs').select('input').eq('id', jobId).single();
  console.log('job.input =', JSON.stringify(job && job.input, null, 2));
  const { data: proj } = await sb.from('projects').select('name').eq('id', projectId).single();
  console.log('project.name =', proj && proj.name);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
