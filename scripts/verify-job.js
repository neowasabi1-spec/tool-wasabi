const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const jobId = process.argv[2];
  const { data: j } = await sb.from('funnel_crawl_jobs').select('id,result').eq('id', jobId).single();
  const steps = (j.result || {}).steps || [];
  for (const s of steps) {
    const h = s.html || '';
    console.log('step', s.stepIndex, Math.round(h.length / 1024) + 'KB',
      '| cssom:', /data-captured-cssom/.test(h) ? 'YES' : 'no');
  }
  // Render a question step offline JS-off
  const qs = steps.find((s) => /quiz\?f=default&a=/.test(s.url || '')) || steps[1] || steps[0];
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 840, height: 1024 }, javaScriptEnabled: false });
  await ctx.route('**/*', (r) => r.abort());
  const p = await ctx.newPage();
  await p.setContent(qs.html, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(1200);
  const out = path.resolve('.tmp-verify.png');
  await p.screenshot({ path: out });
  console.log('rendered step', qs.stepIndex, '->', out);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
