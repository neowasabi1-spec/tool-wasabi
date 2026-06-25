const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  const failed = [];
  p.on('requestfailed', (r) => failed.push(r.url().slice(0, 80) + ' :: ' + (r.failure() && r.failure().errorText)));
  let status = 0;
  p.on('response', (r) => { if (r.url() === url || r.url().startsWith(url.split('?')[0])) status = r.status(); });
  console.log('loading...');
  const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { console.log('GOTO ERR:', e.message); return null; });
  console.log('http status:', resp && resp.status());
  console.log('final url:', p.url());
  await p.waitForTimeout(5000);
  const info = await p.evaluate(() => {
    const html = document.documentElement.outerHTML;
    return {
      title: document.title,
      bodyTextLen: (document.body.innerText || '').length,
      bodyTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      htmlLen: html.length,
      imgs: document.querySelectorAll('img').length,
      iframes: document.querySelectorAll('iframe').length,
      videos: document.querySelectorAll('video').length,
      scripts: document.querySelectorAll('script').length,
      hasNext: !!document.querySelector('#__next'),
      bodyChildren: document.body.children.length,
    };
  }).catch((e) => ({ err: e.message }));
  console.log('\nPAGE INFO:', JSON.stringify(info, null, 2));
  console.log('\nFAILED REQUESTS (' + failed.length + '):');
  for (const f of failed.slice(0, 20)) console.log('  ', f);
  await p.screenshot({ path: '.tmp-drmarty.png', fullPage: false }).catch(() => {});
  console.log('\nscreenshot -> .tmp-drmarty.png');
  await b.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
