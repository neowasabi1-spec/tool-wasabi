// Live walk of bioma intro-question to see WHERE/WHY rendering breaks.
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bodyInfo(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const txt = (main.innerText || '').replace(/\s+/g, ' ').trim();
    const btns = [...document.querySelectorAll('button, [role="button"]')]
      .filter((b) => b.offsetWidth > 10 && b.offsetHeight > 5)
      .map((b) => ({ t: (b.innerText || '').trim().slice(0, 30), dis: !!b.disabled }));
    const inputs = document.querySelectorAll('input').length;
    return { txt: txt.slice(0, 160), btns, inputs, url: location.href };
  });
}

async function clickFirstAnswer(page) {
  // click first visible answer-ish element
  return page.evaluate(() => {
    const cands = [...document.querySelectorAll('label, [class*="option"], [class*="answer"], [class*="card"], li, button')];
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width > 80 && r.height > 30 && s.display !== 'none' && s.visibility !== 'hidden') {
        const t = (el.innerText || '').trim().toLowerCase();
        if (/next|continue|back|skip/.test(t)) continue;
        el.click();
        return t.slice(0, 40) || '(clicked)';
      }
    }
    return null;
  });
}

async function clickNext(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="button"], a')];
    for (const b of btns) {
      const t = (b.innerText || '').trim().toLowerCase();
      if (/next|continue|avanti|submit|get|see|start/.test(t) && !b.disabled) { b.click(); return t.slice(0, 30); }
    }
    return null;
  });
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [console.error]', m.text().slice(0, 160)); });
  page.on('pageerror', (e) => console.log('   [pageerror]', (e.message || '').slice(0, 160)));
  page.on('requestfailed', (r) => console.log('   [reqfailed]', r.failure()?.errorText, r.url().slice(0, 90)));

  await page.goto('https://bioma.health/intro-question', { waitUntil: 'networkidle', timeout: 45000 });
  await sleep(1500);
  console.log('STEP A intro:', JSON.stringify(await bodyInfo(page)));

  // pick "Weight loss"
  const a1 = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')];
    for (const el of els) {
      if ((el.innerText || '').trim().toLowerCase() === 'weight loss' && el.offsetWidth > 50) { el.click(); return true; }
    }
    return false;
  });
  console.log('clicked Weight loss:', a1);
  await sleep(2500);
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('STEP B after WL:', JSON.stringify(await bodyInfo(page)));

  for (let i = 1; i <= 6; i++) {
    const ans = await clickFirstAnswer(page);
    await sleep(800);
    const nx = await clickNext(page);
    await sleep(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    const info = await bodyInfo(page);
    console.log(`STEP ${i}: answer=${ans} next=${nx} -> txt="${info.txt}" inputs=${info.inputs} btns=${JSON.stringify(info.btns)}`);
    await page.screenshot({ path: `.tmp-intro-${i}.png` });
  }
  await b.close();
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
