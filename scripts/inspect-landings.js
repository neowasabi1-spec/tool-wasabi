// List competitor Landings (archived_funnels rows linked to a project).
// Usage: node scripts/inspect-landings.js [projectId]
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL, KEY);
(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { data, error } = await sb
    .from('archived_funnels')
    .select('id, name, steps, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) { console.error('ERROR:', error.message); process.exit(1); }
  console.log(`=== competitor landings (${(data || []).length}) ===`);
  for (const r of data || []) {
    const step = Array.isArray(r.steps) ? r.steps[0] : null;
    const cd = (step && step.cloned_data) || {};
    const shotD = cd.screenshotDesktopUrl ? 'D' : '-';
    const shotM = cd.screenshotMobileUrl ? 'M' : '-';
    const err = cd.shotError ? `  ERR=${cd.shotError}` : '';
    console.log(`- ${r.name}  shots=[${shotD}${shotM}]  src=${(cd.source_url || '').slice(0, 70)}  htmlLen=${(cd.html || '').length}${err}`);
  }
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
