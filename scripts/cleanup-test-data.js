// Remove the test/English pollution I injected while verifying the Google path
// (Shopify/US + "vaginal probiotics" English runs). Keeps the real German
// competitors (brand ids <= KEEP_MAX) and deletes everything above it, plus any
// Shopify test landings.
//
// Usage: node scripts/cleanup-test-data.js [projectId] [keepMaxBrandId]
const { createClient } = require('@supabase/supabase-js');
const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL, KEY);

(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const keepMax = Number(process.argv[3] || '44'); // keep German brands #37..44

  const { data: toDelete } = await sb
    .from('competitor_brands')
    .select('id, name')
    .eq('project_id', projectId)
    .gt('id', keepMax)
    .order('id');
  console.log(`Deleting ${(toDelete || []).length} test brands (id > ${keepMax}):`);
  for (const b of toDelete || []) console.log(`  #${b.id} ${b.name}`);

  // Ads (explicit, in case cascade isn't applied for anon deletes).
  const { error: adErr, count: adCount } = await sb
    .from('competitor_ads')
    .delete({ count: 'exact' })
    .eq('project_id', projectId)
    .gt('brand_id', keepMax);
  console.log(`competitor_ads deleted: ${adCount ?? '?'}${adErr ? ' ERR: ' + adErr.message : ''}`);

  const { error: brErr, count: brCount } = await sb
    .from('competitor_brands')
    .delete({ count: 'exact' })
    .eq('project_id', projectId)
    .gt('id', keepMax);
  console.log(`competitor_brands deleted: ${brCount ?? '?'}${brErr ? ' ERR: ' + brErr.message : ''}`);

  // Test landings (Shopify etc.).
  const { data: lands } = await sb
    .from('archived_funnels')
    .select('id, name, steps')
    .eq('project_id', projectId);
  const junk = (lands || []).filter((l) => {
    const step = Array.isArray(l.steps) ? l.steps[0] : null;
    const src = (step && step.cloned_data && step.cloned_data.source_url) || '';
    return /shopify|pinterest|thrivemarket|gardenoflife/i.test(l.name + ' ' + src);
  });
  for (const l of junk) {
    await sb.from('archived_funnels').delete().eq('id', l.id);
    console.log(`landing deleted: ${l.name}`);
  }
  console.log('\nDone.');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
