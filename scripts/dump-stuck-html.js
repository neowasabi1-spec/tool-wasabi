// Save the HTML of the stuck step and print likely answer elements.
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const urlFilter = process.argv[2] || 'weight-loss';

(async () => {
  const { data } = await sb.from('funnel_crawl_jobs').select('*')
    .order('created_at', { ascending: false }).limit(40);
  const job = (data || []).find((r) => {
    const u = (r.params || {}).entryUrl || r.entry_url || '';
    const diag = (r.result || {}).stopDiagnostic || {};
    return u.includes(urlFilter) && diag.reason === 'no_advance_button';
  });
  if (!job) { console.log('none'); return; }
  const steps = (job.result || {}).steps || [];
  const last = steps[steps.length - 1];
  const html = last && last.html ? last.html : '';
  fs.writeFileSync('.tmp-stuck-step.html', html);
  console.log('saved .tmp-stuck-step.html  len=', html.length, 'url=', last && last.url);

  // Heuristic scan for answer-ish tags.
  const tagRe = /<(button|a|li|label|input|div|span)\b([^>]*)>/gi;
  let m, hits = [];
  while ((m = tagRe.exec(html))) {
    const attrs = m[2] || '';
    if (/role=["'](button|radio|option)|onclick|type=["'](radio|checkbox)|class=["'][^"']*(option|answer|choice|quiz|select|card|btn)/i.test(attrs)) {
      hits.push(`<${m[1]} ${attrs.replace(/\s+/g, ' ').slice(0, 120)}>`);
    }
  }
  console.log('\nclickable-ish tags found:', hits.length);
  for (const h of hits.slice(0, 40)) console.log('  ', h);
})().catch((e) => console.error(e.message));
