const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

async function render(html, blockBioma, outPath) {
  const b = await chromium.launch({ headless: true });
  // JS disabled = static preview of the captured DOM (like the editor).
  const ctx = await b.newContext({ viewport: { width: 900, height: 1100 }, javaScriptEnabled: false });
  if (blockBioma) {
    // Simulate a fresh browser that cannot load bioma's assets.
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (/bioma\.health/i.test(u) && route.request().resourceType() !== 'document') return route.abort();
      return route.continue();
    });
  }
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(2000);
  await p.screenshot({ path: outPath });
  await b.close();
}

(async () => {
  // Pick a recent NON-inlined step (old-worker output).
  const { data } = await sb.from('funnel_crawl_jobs')
    .select('id,result').order('created_at', { ascending: false }).limit(8);
  let chosen = null;
  for (const j of data) {
    for (const s of ((j.result || {}).steps || [])) {
      const h = s.html || '';
      const isQuestion = /quiz\?question|step=/.test(s.url || '');
      if (h && isQuestion && !/data-inlined-from/.test(h) && /<link[^>]+stylesheet/i.test(h)) { chosen = { j: j.id, s }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) { console.log('no non-inlined step found'); process.exit(0); }
  let html = chosen.s.html;
  // Replicate what the editor does: inject <base href> to the source origin.
  const origin = new URL(chosen.s.url).origin + '/';
  if (!/<base\b/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}">`);
  console.log('using non-inlined step from job', chosen.j, '| origin', origin);

  await render(html, false, path.resolve('.tmp-master-like.png'));
  console.log('wrote .tmp-master-like.png (bioma reachable = like MASTER browser)');
  await render(html, true, path.resolve('.tmp-user-like.png'));
  console.log('wrote .tmp-user-like.png (bioma blocked = like USER browser)');
})().catch((e) => { console.error(e.message); process.exit(1); });
