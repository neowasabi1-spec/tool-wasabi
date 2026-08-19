// List project_files rows for a project (to verify Autopilot section saving).
// Usage: node scripts/inspect-project-files.js <projectId>
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { data, error } = await sb
    .from('project_files')
    .select('id, file_type, original_name, file_path, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  console.log(`project_files for ${projectId} (${data.length})`);
  for (const f of data) {
    console.log(` - ${String(f.file_type).padEnd(16)} ${f.original_name}`);
  }
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
