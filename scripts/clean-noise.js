// Remove platform/agency noise brands (+their ads) and jobs/noise landings
// from a project, matching the same denylist used at ingest time.
// Usage: node scripts/clean-noise.js [projectId]
const { createClient } = require('@supabase/supabase-js');
const URL_SB = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(URL_SB, KEY);
const NOISE = /(shopify|whatchimp|manychat|klaviyo|mailchimp|hubspot|salesforce|semrush|ahrefs|wix|squarespace|godaddy|printful|printify|oberlo|aliexpress|alibaba|fiverr|upwork|canva|easyads|adspy|clickfunnels|kajabi|teachable|shesellsremote|podpluser)/i;
const JOBS = /(^|\.)(jobs|careers|karriere|recruiting)\.|\.personio\.|\.jobs\./i;
(async () => {
  const projectId = process.argv[2] || '53738dcb-862c-41e0-b422-c45101518d4a';
  const { data: brands } = await sb.from('competitor_brands').select('id, name').eq('project_id', projectId);
  for (const b of brands || []) {
    if (NOISE.test(b.name)) {
      await sb.from('competitor_ads').delete().eq('project_id', projectId).eq('brand_id', b.id);
      await sb.from('competitor_brands').delete().eq('id', b.id);
      console.log('deleted noise brand:', b.name);
    }
  }
  const { data: lands } = await sb.from('archived_funnels').select('id, name, steps').eq('project_id', projectId);
  for (const l of lands || []) {
    const step = Array.isArray(l.steps) ? l.steps[0] : null;
    const src = (step && step.cloned_data && step.cloned_data.source_url) || '';
    let host = '';
    try { host = new URL(src).hostname; } catch {}
    if (NOISE.test(l.name + ' ' + src) || JOBS.test(host)) {
      await sb.from('archived_funnels').delete().eq('id', l.id);
      console.log('deleted noise landing:', l.name, src);
    }
  }
  console.log('Done.');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
