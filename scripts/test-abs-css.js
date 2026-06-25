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
      if (/quiz|step=|question/.test(s.url || '') && (s.html || '').length > 8000) { step = s; break; }
    }
    if (step) break;
  }
  let html = step.html;
  const origin = new URL(step.url).origin;
  // Absolutize root-relative href/src to source origin (like prepareEditorHtml)
  html = html.replace(/(\s(?:href|src))=(["'])(\/[^"'/][^"']*)\2/gi, (_m, a, q, v) => `${a}=${q}${origin}${v}${q}`);
  // also <base> for safety
  if (!/<base\b/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);

  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 900, height: 1100 }, javaScriptEnabled: false }); // JS OFF, network ON
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(2500);
  const out = path.resolve('.tmp-abs-css.png');
  await p.screenshot({ path: out });
  console.log('step url:', step.url);
  console.log('screenshot:', out);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
