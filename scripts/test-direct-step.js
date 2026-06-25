const { chromium } = require('playwright');
const u = process.argv[2];
(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1000, height: 1000 } });
  const p = await ctx.newPage();
  await p.goto(u, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console.log('goto err', e.message));
  await p.waitForTimeout(4000);
  const info = await p.evaluate(() => {
    const m = document.querySelector('main') || document.body;
    return {
      txt: (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      inputs: document.querySelectorAll('input').length,
      btns: document.querySelectorAll('button').length,
    };
  });
  console.log('DIRECT LOAD:', JSON.stringify(info));
  await p.screenshot({ path: '.tmp-direct.png' });
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
