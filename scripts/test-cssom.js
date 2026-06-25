// Proof: capture the LIVE CSSOM (incl. JS-injected / adopted stylesheets)
// into a <style>, then render the result with JS OFF + network OFF.
// If styled => this is the correct capture fix for the worker.
const path = require('path');
const { chromium } = require('playwright');
const URL = process.argv[2] || 'https://bioma.health/weight-loss/quiz?question=1';

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 900, height: 1100 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
  await p.waitForTimeout(3000);

  // Inject a <style> with every CSS rule currently applied (all sheets).
  const stats = await p.evaluate(() => {
    const origin = location.origin;
    function rewrite(css) {
      return css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/)([^'")]+)\1\s*\)/gi,
        (m, q, u) => { try { return 'url(' + new URL(u, origin).href + ')'; } catch { return m; } });
    }
    let css = '';
    let sheets = 0, rules = 0, blocked = 0;
    const collect = (list) => {
      for (const sheet of list) {
        sheets++;
        try {
          for (const rule of sheet.cssRules) { css += rule.cssText + '\n'; rules++; }
        } catch { blocked++; }
      }
    };
    collect(document.styleSheets);
    collect(document.adoptedStyleSheets || []);
    css = rewrite(css);
    const style = document.createElement('style');
    style.setAttribute('data-captured-cssom', '');
    style.textContent = css;
    document.head.appendChild(style);
    return { sheets, rules, blocked, cssLen: css.length };
  });
  console.log('CSSOM capture:', JSON.stringify(stats));

  const html = await p.content();
  await b.close();

  // Render captured HTML with JS OFF + ALL network blocked.
  const b2 = await chromium.launch({ headless: true });
  const ctx2 = await b2.newContext({ viewport: { width: 900, height: 1100 }, javaScriptEnabled: false });
  await ctx2.route('**/*', (r) => r.abort());
  const p2 = await ctx2.newPage();
  await p2.setContent(html, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p2.waitForTimeout(1500);
  const out = path.resolve('.tmp-cssom.png');
  await p2.screenshot({ path: out });
  console.log('screenshot:', out);
  await b2.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
