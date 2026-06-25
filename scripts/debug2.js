// Drive the bioma quiz with REAL Playwright clicks (proper event dispatch),
// no request interception, to see if client navigation renders each step.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function info(page) {
  return page.evaluate(() => {
    const m = document.querySelector('main') || document.body;
    return {
      url: location.href.slice(0, 95),
      txt: (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      cards: document.querySelectorAll('[class*="option"],[class*="answer"],[class*="card"],label').length,
      controls: document.querySelectorAll('button,[role="button"],input').length,
    };
  });
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  // Replicate the worker's request interception to see if it breaks nav.
  if (process.env.INTERCEPT === '1') {
    const BLOCKED = ['googletagmanager', 'google-analytics', 'analytics.google', 'facebook', 'connect.facebook', 'hotjar', 'clarity.ms', 'doubleclick', 'amazon-adsystem', 'rtbrain', 'aggle.net', 'kaptcha', 'shop.pe'];
    await page.route('**/*', (route) => {
      try {
        const u = route.request().url();
        const t = route.request().resourceType();
        if (t === 'media' || t === 'websocket') return route.abort();
        for (const h of BLOCKED) if (u.includes(h)) return route.abort();
        return route.continue();
      } catch { return route.continue(); }
    });
    console.log('[interception ON]');
  }
  await page.goto('https://bioma.health/intro-question', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  console.log('intro:', JSON.stringify(await info(page)));

  // Click "Weight loss" option (real click on the clickable element)
  try {
    await page.getByText('Weight loss', { exact: true }).first().click({ timeout: 5000 });
  } catch (e) { console.log('WL click err', e.message.slice(0, 80)); }
  await sleep(3000);
  console.log('after WL:', JSON.stringify(await info(page)));

  const SYNTH = process.env.SYNTH === '1';
  for (let i = 1; i <= 22; i++) {
    // If we're on the height step, dump its widgets in detail and stop.
    const lbl = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 60));
    if (/what'?s your (height|weight)|how tall are you|how much do you weigh/i.test(lbl)) {
      const detail = await page.evaluate(() => {
        const out = { label: (document.querySelector('main') || document.body).innerText.replace(/\s+/g, ' ').trim().slice(0, 160), controls: [], pointers: [] };
        document.querySelectorAll('input, select, button, [role="button"], [role="tab"], [role="slider"], [role="spinbutton"]').forEach((el) => {
          const r = el.getBoundingClientRect(); if (r.width < 3 || r.height < 3) return;
          out.controls.push({ tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text: ((el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '') + '').trim().slice(0, 30), cls: (el.className || '').toString().slice(0, 50), disabled: !!el.disabled });
        });
        document.querySelectorAll('div,span,li,button').forEach((el) => { try { if (getComputedStyle(el).cursor !== 'pointer') return; const t = (el.innerText || '').trim(); if (!t || t.length > 20) return; const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return; out.pointers.push({ t, cls: (el.className || '').toString().slice(0, 40) }); } catch {} });
        return out;
      });
      console.log('\n=== HEIGHT/WEIGHT STEP REACHED (i=' + i + ') ===');
      console.log('LABEL:', detail.label);
      console.log('CONTROLS:'); for (const c of detail.controls.slice(0, 30)) console.log('  ', JSON.stringify(c));
      console.log('POINTERS:'); for (const c of detail.pointers.slice(0, 30)) console.log('  ', JSON.stringify(c));
      await page.screenshot({ path: '.tmp-height.png' });
      console.log('screenshot -> .tmp-height.png');
      const answerMatch = await page.evaluate(() => {
        const sel = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"], [class*="option"], [class*="answer"], [class*="choice"]';
        return [...document.querySelectorAll(sel)].map((el) => ({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), txt: (el.innerText || '').trim().slice(0, 25) })).slice(0, 10);
      });
      console.log('ANSWER-SELECTOR MATCHES on height:', JSON.stringify(answerMatch));
      // Try to fill the inputs with real .fill() and click Next.
      const inputs = page.locator('input[type="number"], input[type="text"], input:not([type])');
      const ni = await inputs.count();
      console.log('fillable inputs:', ni);
      for (let k = 0; k < ni; k++) {
        const inp = inputs.nth(k);
        const ph = await inp.evaluate((el) => `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${(el.closest('label') || {}).innerText || ''}`).catch(() => '');
        const v = /in\b|inch/i.test(ph) ? '8' : '5';
        try { await inp.fill(v, { timeout: 2000 }); console.log(`  filled input ${k} ("${ph.trim().slice(0,20)}") = ${v}`); } catch (e) { console.log('  fill err', e.message.slice(0, 60)); }
      }
      await sleep(800);
      const nextEnabled = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /next|continue/i.test(x.innerText || ''));
        return b ? { found: true, disabled: b.disabled, text: b.innerText.trim() } : { found: false };
      });
      console.log('NEXT after fill:', JSON.stringify(nextEnabled));
      const nbtn = page.getByRole('button', { name: /next|continue/i });
      if (await nbtn.count()) { try { await nbtn.first().click({ timeout: 3000 }); } catch (e) { console.log('next click err', e.message.slice(0,60)); } }
      await sleep(3000);
      const after = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.replace(/\s+/g, ' ').slice(0, 80));
      console.log('AFTER NEXT:', after);
      // Dump the weight-step inputs' hints to confirm current/goal detection.
      const wHints = await page.evaluate(() => {
        return [...document.querySelectorAll('input')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 5 && r.height > 5 && !['radio', 'checkbox', 'hidden'].includes((el.type || '').toLowerCase()); }).map((el) => `${el.name || ''}|${el.id || ''}|${el.placeholder || ''}|${el.getAttribute('aria-label') || ''}|${(el.closest('label') || {}).innerText || ''}|${(el.parentElement || {}).innerText || ''}`.replace(/\s+/g, ' ').slice(0, 100));
      });
      console.log('WEIGHT INPUT HINTS:'); for (const x of wHints) console.log('  ', JSON.stringify(x));
      break;
    }
    // pick first answer card if present
    const before = page.url();
    let picked = '(none)';
    if (SYNTH) {
      // Mimic the worker: in-page el.click() (synthetic DOM click).
      picked = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[class*="option"], [class*="answer"], label')].filter((c) => (c.innerText || '').trim());
        if (cards[0]) { cards[0].click(); return (cards[0].innerText || '').trim().slice(0, 25); }
        return '(none)';
      });
      await sleep(700);
    } else {
      const cards = page.locator('[class*="option"], [class*="answer"], label').filter({ hasText: /\w/ });
      const n = await cards.count().catch(() => 0);
      if (n > 0) {
        try { await cards.first().click({ timeout: 3000 }); picked = await cards.first().innerText().catch(() => ''); } catch {}
        await sleep(700);
      }
    }
    // click Next (enabled)
    let nextClicked = false;
    if (SYNTH) {
      nextClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, [role="button"], a')];
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (/next|continue|avanti|submit|get|see|start/.test(t) && !b.disabled) { b.click(); return true; }
        }
        return false;
      });
    } else {
      const next = page.getByRole('button', { name: /next|continue|avanti|submit|get|see results|start/i });
      if (await next.count().catch(() => 0)) {
        try { await next.first().click({ timeout: 3000 }); nextClicked = true; } catch (e) {}
      }
    }
    await sleep(3000);
    const after = await info(page);
    console.log(`Q${i}: picked="${(picked || '').slice(0, 25)}" next=${nextClicked} changed=${before !== page.url()} -> ${JSON.stringify(after)}`);
  }
  await b.close();
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
