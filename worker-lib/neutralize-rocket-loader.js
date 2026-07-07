/**
 * CommonJS mirror of src/lib/neutralize-rocket-loader.ts for the Node worker.
 *
 * Cloudflare Rocket Loader rewrites inline scripts to a non-executable MIME
 * type (`type="<hex>-text/javascript"`) and relies on rocket-loader.min.js to
 * run them. On a cloned origin that loader 404s, so the page's inline scripts
 * (live chat/comments engine, counters, countdown) never execute. This reverses
 * the transformation so they run natively. No-op on non-Rocket-Loader pages.
 */
function neutralizeRocketLoader(html) {
  if (!html) return { html: html, restored: 0, loaderRemoved: false };

  const restored = (html.match(/type=(["'])[0-9a-f]{8,}-(?:text\/javascript|application\/javascript|module)\1/gi) || []).length;

  let out = html;

  out = out.replace(
    /type=(["'])[0-9a-f]{8,}-(text\/javascript|application\/javascript|module)\1/gi,
    'type=$1$2$1',
  );

  out = out.replace(/\sdata-rocket-?src=/gi, ' src=');
  out = out.replace(/\sdata-rocketoptimized(=(["']).*?\2)?/gi, '');

  const loaderRe =
    /<script\b[^>]*\/cdn-cgi\/scripts\/[^>]*rocket-loader[^>]*>\s*<\/script>/gi;
  const loaderRemoved = loaderRe.test(out);
  out = out.replace(loaderRe, '');

  return { html: out, restored: restored, loaderRemoved: loaderRemoved };
}

module.exports = { neutralizeRocketLoader };
