// Verify the Autopilot produced VISIBLE artifacts for a project:
// funnel_steps (landing mockup + ads doc), competitor_brands, competitor_ads.
// Usage: node scripts/inspect-outputs.js <projectId>
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

(async () => {
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';

  const { data: steps } = await supabase
    .from('funnel_steps')
    .select('id, step_number, page_name, step_type, status, auto_gen, flow_name, result_content')
    .eq('project_id', projectId)
    .order('step_number', { ascending: true });
  console.log('\n=== funnel_steps ===');
  for (const s of steps || []) {
    console.log(`#${s.step_number} [${s.step_type}] ${s.page_name} — ${s.status} auto=${s.auto_gen} flow=${s.flow_name} htmlLen=${(s.result_content||'').length}`);
  }

  const { data: brands } = await supabase
    .from('competitor_brands')
    .select('id, name, ads_library_url, last_run_id, last_scraped')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  console.log('\n=== competitor_brands ===');
  for (const b of brands || []) {
    console.log(`#${b.id} ${b.name} run=${b.last_run_id||'-'} scraped=${b.last_scraped||'-'}\n   url=${(b.ads_library_url||'').slice(0,120)}`);
  }

  const { data: ads, count } = await supabase
    .from('competitor_ads')
    .select('id, media_type, headline, hook', { count: 'exact' })
    .eq('project_id', projectId)
    .limit(5);
  console.log(`\n=== competitor_ads (${count ?? (ads||[]).length}) ===`);
  for (const a of ads || []) console.log(`  [${a.media_type}] ${a.headline || a.hook || ''}`.slice(0,100));

  const { data: outs } = await supabase
    .from('creative_outputs')
    .select('id, type, angle')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\n=== creative_outputs ===');
  for (const o of outs || []) console.log(`  [${o.type}] ${o.angle}`);
})();
