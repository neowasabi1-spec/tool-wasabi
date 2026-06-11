const { chromium } = require('playwright');
const URL = process.argv[2] || 'https://bioma.health/weight-loss/quiz?question=1';
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(2500);
  // Run the EXACT inline logic from openclaw-worker.js inlineStylesheetsForCapture
  const inlined = await p.evaluate(async () => {
    const MAX_TOTAL = 1_500_000;
    let total = 0;
    let inlined = 0;
    const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'));
    for (const link of links) {
      const href = link.href;
      if (!href || /^data:/i.test(href)) continue;
      try {
        const res = await fetch(href, { credentials: 'include' });
        if (!res || !res.ok) continue;
        let css = await res.text();
        if (!css) continue;
        css = css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/)([^'")]+)\1\s*\)/gi, (m, q, u) => {
          try { return 'url(' + new URL(u, href).href + ')'; } catch { return m; }
        });
        total += css.length;
        if (total > MAX_TOTAL) break;
        const style = document.createElement('style');
        style.setAttribute('data-inlined-from', href);
        style.textContent = css;
        if (link.parentNode) { link.parentNode.replaceChild(style, link); inlined++; }
      } catch { /* leave */ }
    }
    return inlined;
  });
  const html = await p.content();
  const remainingLinks = (html.match(/<link[^>]+stylesheet/gi) || []).length;
  const inlinedStyles = (html.match(/data-inlined-from/g) || []).length;
  console.log('inlined count:', inlined);
  console.log('resulting HTML:', Math.round(html.length / 1024) + 'KB', '| <style data-inlined-from>:', inlinedStyles, '| remaining <link stylesheet>:', remainingLinks);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
