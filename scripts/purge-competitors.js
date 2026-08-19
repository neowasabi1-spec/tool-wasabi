// Full reset of competitor discovery data for a project: deletes ALL
// competitor_ads, competitor_brands and archived_funnels landings so a fresh
// (correctly geo/language-targeted) run starts from a clean slate.
// Usage: node scripts/purge-competitors.js [projectId]
const { createClient } = require('@supabase/supabase-js');
const URL_SB = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_SB, KEY);
(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { count: adCount, error: adErr } = await sb
    .from('competitor_ads').delete({ count: 'exact' }).eq('project_id', projectId);
  console.log(`competitor_ads deleted: ${adCount ?? '?'}${adErr ? ' ERR ' + adErr.message : ''}`);
  const { count: brCount, error: brErr } = await sb
    .from('competitor_brands').delete({ count: 'exact' }).eq('project_id', projectId);
  console.log(`competitor_brands deleted: ${brCount ?? '?'}${brErr ? ' ERR ' + brErr.message : ''}`);
  const { count: lnCount, error: lnErr } = await sb
    .from('archived_funnels').delete({ count: 'exact' }).eq('project_id', projectId);
  console.log(`archived_funnels deleted: ${lnCount ?? '?'}${lnErr ? ' ERR ' + lnErr.message : ''}`);
  console.log('Done.');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
