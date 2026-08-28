/* Local renderer for the screenshot backfill: pulls saved HTML from the temp
 * server route, renders it in local Chrome (system browser via playwright-core
 * channel), captures desktop+mobile full-page JPEGs, ships them back. */
const { chromium } = require('playwright-core');

const BASE = 'https://cute-cupcake-74bad8.netlify.app/api/debug-shots';
const TOKEN = 'wsb-diag-8f3a1c6e2b';
const MAX_H = 9000;

async function api(action, opts = {}) {
  const url = `${BASE}?token=${TOKEN}&action=${action}${opts.query || ''}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, opts.post ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts.post),
      } : undefined);
      if (r.status === 504) throw new Error('504');
      if (opts.raw) return await r.text();
      return await r.json();
    } catch (e) {
      if (a === 3) throw e;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

async function shoot(browser, html, variant) {
  const viewport = variant === 'desktop' ? { width: 1280, height: 800 } : { width: 390, height: 844 };
  const context = await browser.newContext({
    viewport,
    isMobile: false, // channel:'chrome' doesn't support isMobile
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    userAgent: variant === 'mobile'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  try {
    await context.route(/\.(mp4|webm|mov|avi|m3u8|ts)(\?|$)/i, (r) => r.abort().catch(() => {}));
    const page = await context.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
    await page.waitForTimeout(2000);
    try {
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const iv = setInterval(() => {
            window.scrollBy(0, 800); total += 800;
            if (total >= document.body.scrollHeight - window.innerHeight || total > 15000) {
              clearInterval(iv); window.scrollTo(0, 0); setTimeout(resolve, 400);
            }
          }, 60);
        });
      });
    } catch {}
    const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    const clipH = Math.min(MAX_H, pageHeight || viewport.height);
    const buf = await page.screenshot({
      type: 'jpeg', quality: 72,
      fullPage: clipH >= (pageHeight || 0),
      clip: clipH < (pageHeight || 0) ? { x: 0, y: 0, width: viewport.width, height: clipH } : undefined,
    });
    return buf;
  } finally {
    await context.close().catch(() => {});
  }
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); } catch {}
  }
  return await chromium.launch({ headless: true }); // playwright-managed binary
}

async function main() {
  const list = await api('list');
  if (!list.items) { console.log('list failed:', JSON.stringify(list).slice(0, 300)); return; }
  console.log(`pending: ${list.items.length}`);

  const browser = await launch();
  let ok = 0, failed = 0;
  try {
    for (let i = 0; i < list.items.length; i++) {
      const it = list.items[i];
      try {
        const html = await api('html', { query: `&pageId=${encodeURIComponent(it.pageId)}`, raw: true });
        if (!html || html.length < 200) {
          await api('patch', { post: { rowId: it.rowId, stepIdx: it.stepIdx, failed: true } });
          failed++; console.log(`[${i + 1}/${list.items.length}] ${it.pageId} NO HTML`);
          continue;
        }
        const dBuf = await shoot(browser, html, 'desktop');
        const mBuf = await shoot(browser, html, 'mobile');
        const dRes = await api('shot', { post: { pageId: it.pageId, variant: 'desktop', dataUrl: `data:image/jpeg;base64,${dBuf.toString('base64')}` } });
        const mRes = mBuf ? await api('shot', { post: { pageId: it.pageId, variant: 'mobile', dataUrl: `data:image/jpeg;base64,${mBuf.toString('base64')}` } }) : {};
        if (!dRes.url) {
          console.log(`[${i + 1}] upload failed: ${JSON.stringify(dRes).slice(0, 200)}`);
          failed++;
          continue;
        }
        await api('patch', { post: { rowId: it.rowId, stepIdx: it.stepIdx, desktopUrl: dRes.url, mobileUrl: mRes.url || '' } });
        ok++;
        console.log(`[${i + 1}/${list.items.length}] ${it.pageId} OK (${Math.round(dBuf.length / 1024)}KB)`);
      } catch (e) {
        failed++;
        console.log(`[${i + 1}/${list.items.length}] ${it.pageId} ERROR: ${e.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`ALL DONE ok=${ok} failed=${failed}`);
}
main();
