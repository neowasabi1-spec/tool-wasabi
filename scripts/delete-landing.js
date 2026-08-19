// Delete competitor landings created from a manually-provided link
// (method_used === 'competitor-link') for a project.
// Usage: node scripts/delete-landing.js [projectId]
const { createClient } = require('@supabase/supabase-js');
const URL_SB = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_SB, KEY);
(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { data } = await sb.from('archived_funnels').select('id, name, steps').eq('project_id', projectId);
  for (const r of data || []) {
    const s = Array.isArray(r.steps) ? r.steps[0] : null;
    const method = s && s.cloned_data && s.cloned_data.method_used;
    if (method === 'competitor-link') {
      await sb.from('archived_funnels').delete().eq('id', r.id);
      console.log('deleted landing:', r.name, r.id);
    }
  }
  console.log('done');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
