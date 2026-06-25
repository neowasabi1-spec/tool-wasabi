// Inspect mounjfit.shop quiz structure: how it advances, load timing, stuck cause.
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2] || 'https://mounjfit.shop/';
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 420, height: 880 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
  const p = await ctx.newPage();
  const reqs = [];
  p.on('request', (r) => reqs.push(r.resourceType()));
  console.log('loading', url);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto', e.message));
  for (let t = 1; t <= 4; t++) {
    await p.waitForTimeout(2000);
    const snap = await p.evaluate(() => {
      const body = document.body;
      const txt = (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const imgs = [...document.querySelectorAll('img')];
      const imgsLoaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
      const vids = document.querySelectorAll('video, iframe').length;
      const btns = [...document.querySelectorAll('button, a[href], [role="button"], [onclick]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8; }).map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 25)).filter(Boolean).slice(0, 12);
      return { url: location.href, txt, imgs: imgs.length, imgsLoaded, vids, btns, htmlLen: document.documentElement.outerHTML.length };
    });
    console.log(`\n[t=${t * 2}s]`, JSON.stringify(snap, null, 0));
  }
  const rc = {};
  reqs.forEach((t) => (rc[t] = (rc[t] || 0) + 1));
  console.log('\nrequests by type:', JSON.stringify(rc));
  // framework detection
  const fw = await p.evaluate(() => ({ next: !!document.querySelector('#__next, script#__NEXT_DATA__'), react: !!window.React || !!document.querySelector('[data-reactroot]'), gtm: !!window.google_tag_manager, wistia: !!window.Wistia, vturb: !!document.querySelector('[id*="vid"],[class*="vturb"],vturb-smartplayer'), funnelish: /funnelish|cartpanda|clickfunnels|systeme/i.test(document.documentElement.outerHTML) }));
  console.log('framework hints:', JSON.stringify(fw));
  await p.screenshot({ path: '.tmp-mounjfit.png', fullPage: false });
  console.log('screenshot -> .tmp-mounjfit.png');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
