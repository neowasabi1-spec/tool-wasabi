const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const html = fs.readFileSync('.tmp-inlined-step.html', 'utf8');
  const b = await chromium.launch({ headless: true });
  // JS OFF + block ALL network so only the inlined CSS can style the page.
  const ctx = await b.newContext({ viewport: { width: 900, height: 1200 }, javaScriptEnabled: false });
  await ctx.route('**/*', (route) => route.abort());
  const p = await ctx.newPage();
  await p.setContent(html, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const out = path.resolve('.tmp-inlined-render.png');
  await p.screenshot({ path: out, fullPage: false });
  console.log('screenshot:', out);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
