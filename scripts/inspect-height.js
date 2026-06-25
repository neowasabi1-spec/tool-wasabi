// Load the "What's your height?" step live and dump its interactive widgets
// so we can teach the worker how to answer it.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);
(async () => {
  const { data } = await sb.from('funnel_crawl_jobs').select('id,result').order('created_at', { ascending: false }).limit(1);
  const steps = (data[0].result || {}).steps || [];
  const h = steps.find((s) => /height/i.test(s.quizStepLabel || ''));
  const url = h ? h.url : process.argv[2];
  console.log('loading height step:', url);
  const b = await chromium.launch({ headless: true });
  const p = await (await b.newContext({ viewport: { width: 1100, height: 950 } })).newPage();
  await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console.log('goto', e.message));
  await p.waitForTimeout(3500);
  const dump = await p.evaluate(() => {
    const out = { label: '', controls: [], pointers: [], tabs: [], sliders: [] };
    const m = document.querySelector('main') || document.body;
    out.label = (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    document.querySelectorAll('input, select, textarea, button, [role="button"], [role="tab"], [role="slider"], [contenteditable]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return;
      out.controls.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || el.getAttribute('role') || '',
        text: ((el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '') + '').trim().slice(0, 40),
        cls: (el.className || '').toString().slice(0, 60),
        disabled: !!el.disabled,
      });
    });
    // pointer-cursor elements that look like pickers (cm/ft toggles, numbers)
    document.querySelectorAll('div,span,li,button').forEach((el) => {
      try {
        if (getComputedStyle(el).cursor !== 'pointer') return;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 25) return;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        out.pointers.push({ t, cls: (el.className || '').toString().slice(0, 50) });
      } catch {}
    });
    return out;
  });
  console.log('LABEL:', dump.label);
  console.log('\nCONTROLS (', dump.controls.length, '):');
  for (const c of dump.controls.slice(0, 40)) console.log('  ', JSON.stringify(c));
  console.log('\nPOINTER ELS (', dump.pointers.length, '):');
  for (const c of dump.pointers.slice(0, 40)) console.log('  ', JSON.stringify(c));
  await p.screenshot({ path: '.tmp-height.png' });
  console.log('\nscreenshot -> .tmp-height.png');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
