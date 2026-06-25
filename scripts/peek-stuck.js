const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
const jobId = process.argv[2];
const idx = Number(process.argv[3] || 4);
(async () => {
  const { data: j } = await sb.from('funnel_crawl_jobs').select('result').eq('id', jobId).single();
  const s = ((j.result || {}).steps || []).find((x) => x.stepIndex === idx);
  if (!s) { console.log('no step', idx); return; }
  let h = s.html || '';
  // strip the captured CSS <style> to read structure
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  // visible text
  const text = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('URL:', s.url);
  console.log('TEXT (first 500):', text.slice(0, 500));
  console.log('---');
  // form controls
  const inputs = h.match(/<(input|textarea|select|button)\b[^>]*>/gi) || [];
  console.log('controls:', inputs.length);
  for (const c of inputs.slice(0, 25)) console.log('  ', c.replace(/\s+/g, ' ').slice(0, 160));
  // role buttons / clickable divs
  const roleBtns = h.match(/<[a-z]+[^>]*role="button"[^>]*>/gi) || [];
  console.log('role=button:', roleBtns.length);
})().catch((e) => { console.error(e.message); process.exit(1); });
