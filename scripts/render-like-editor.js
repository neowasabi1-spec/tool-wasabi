const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,result').order('created_at', { ascending: false }).limit(10);
  let step = null;
  for (const j of data) {
    for (const s of ((j.result || {}).steps || [])) {
      if (/quiz\?question|step=/.test(s.url || '') && /<link[^>]+stylesheet/i.test(s.html || '')) { step = s; break; }
    }
    if (step) break;
  }
  if (!step) { console.log('no step'); return; }
  let html = step.html;
  const origin = new URL(step.url).origin + '/';
  if (!/<base\b/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}">`);

  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 900, height: 1100 } }); // JS ON, network ON
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'load' }).catch(() => {});
  await p.waitForTimeout(3500);
  const out = path.resolve('.tmp-editor-like.png');
  await p.screenshot({ path: out });
  console.log('step url:', step.url);
  console.log('screenshot:', out);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
