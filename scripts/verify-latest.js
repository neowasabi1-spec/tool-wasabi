const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,created_at,result').order('created_at', { ascending: false }).limit(1);
  const j = data[0];
  const steps = (j.result || {}).steps || [];
  console.log('job', j.id.slice(0, 8), '| steps:', steps.length);
  for (const s of steps) {
    const h = s.html || '';
    console.log(`  step ${s.stepIndex}: "${(s.quizStepLabel || '').slice(0, 45)}" ${Math.round(h.length/1024)}KB cssom=${/data-captured-cssom/.test(h) ? 'Y' : 'n'}`);
  }
  const idx = Number(process.argv[2] || 6);
  const s = steps.find((x) => x.stepIndex === idx) || steps[5];
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 840, height: 1024 }, javaScriptEnabled: false });
  await ctx.route('**/*', (r) => r.abort());
  const p = await ctx.newPage();
  await p.setContent(s.html, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(1200);
  const out = path.resolve('.tmp-verify.png');
  await p.screenshot({ path: out });
  console.log('rendered step', s.stepIndex, '"' + (s.quizStepLabel || '') + '" ->', out);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
