// Drive mounjfit.shop quiz: click Start, then advance step by step, logging
// how navigation works and where it could get stuck.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 420, height: 880 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
  const p = await ctx.newPage();
  await p.goto('https://mounjfit.shop/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto', e.message));
  await sleep(2500);

  const snap = async () => p.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const opts = [...document.querySelectorAll('button, a[href], [role="button"], [onclick], label, .option, [class*="option"], [class*="answer"], [class*="card"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 12; }).map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)).filter(Boolean);
    const imgs = [...document.querySelectorAll('img')];
    return { url: location.href, txt, opts: [...new Set(opts)].slice(0, 10), imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length + '/' + imgs.length };
  });

  console.log('STEP0:', JSON.stringify(await snap()));
  // Click the start button
  const start = p.locator('button, a, [role="button"]').filter({ hasText: /start|começar|começa|iniciar|transform/i }).first();
  if (await start.count()) { await start.click().catch((e) => console.log('start click', e.message)); }
  await sleep(2500);

  for (let i = 1; i <= 25; i++) {
    const before = await snap();
    // Pick a real answer: a clickable with substantial text, NOT the progress
    // bar (e.g. "20%"), NOT back/next-only chrome.
    const clickedText = await p.evaluate(() => {
      const cand = [...document.querySelectorAll('button, a[href], [role="button"], label, [class*="option"], [class*="answer"], [class*="card"], li')];
      const isAnswer = (el) => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length < 3) return false;
        if (/^\d+%$/.test(t)) return false; // progress
        if (/^(back|voltar|anterior|next|continuar|continue)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 24 && getComputedStyle(el).display !== 'none';
      };
      // Prefer the deepest answer-looking element to avoid clicking a wrapper.
      const answers = cand.filter(isAnswer).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      const el = answers[0];
      if (!el) return '(no target)';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    });
    await sleep(1800);
    const after = await snap();
    const changed = after.txt !== before.txt || after.url !== before.url;
    console.log(`\nSTEP${i}: click="${clickedText}" changed=${changed}`);
    console.log('  ->', JSON.stringify(after));
    if (!changed) { console.log('  ⚠ STUCK — content did not change'); }
  }
  await p.screenshot({ path: '.tmp-mounjfit-drive.png' });
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
