/**
 * Neutralize Cloudflare Rocket Loader in cloned HTML.
 *
 * Cloudflare Rocket Loader (an "optimization" many funnel pages enable) does
 * NOT ship normal executable inline scripts to the browser. Instead it:
 *
 *   1. rewrites every inline  <script type="text/javascript">  to
 *      <script type="<24-hex-token>-text/javascript">  — an unknown MIME type
 *      the browser refuses to execute natively;
 *   2. moves external `src` to `data-rocketsrc` (or `data-rocket-src`);
 *   3. injects  /cdn-cgi/scripts/<hash>/cloudflare-static/rocket-loader.min.js
 *      which, once loaded, walks those tags and executes them itself.
 *
 * When we clone the page onto another origin, that rocket-loader.min.js URL is
 * relative and 404s (returns HTML → "Unexpected token '<'"), so the loader
 * never runs and NONE of the page's inline scripts execute. Result: the live
 * chat / comments engine, viewer counter, countdown and offer-reveal logic are
 * all dead — the page looks static and the comments section never populates.
 *
 * This helper reverses the transformation so the inline scripts run natively:
 *   - `type="<token>-text/javascript"` → `type="text/javascript"`
 *   - `data-rocketsrc=` → `src=`  (and drops `data-rocketoptimized`)
 *   - removes the rocket-loader.min.js <script> tag entirely
 *
 * It is a no-op on pages that don't use Rocket Loader, so it is safe to run on
 * every clone whose scripts we keep.
 */
export function neutralizeRocketLoader(html: string): {
  html: string;
  restored: number;
  loaderRemoved: boolean;
} {
  if (!html) return { html, restored: 0, loaderRemoved: false };

  const restored = (html.match(/type=(["'])[0-9a-f]{8,}-(?:text\/javascript|application\/javascript|module)\1/gi) || []).length;

  let out = html;

  // 1) Restore mangled script types.
  out = out.replace(
    /type=(["'])[0-9a-f]{8,}-(text\/javascript|application\/javascript|module)\1/gi,
    'type=$1$2$1',
  );

  // 2) Restore deferred external src and drop rocket bookkeeping attributes.
  out = out.replace(/\sdata-rocket-?src=/gi, ' src=');
  out = out.replace(/\sdata-rocketoptimized(=(["']).*?\2)?/gi, '');

  // 3) Remove the Rocket Loader script itself (relative URL, 404s on clones).
  const loaderRe =
    /<script\b[^>]*\/cdn-cgi\/scripts\/[^>]*rocket-loader[^>]*>\s*<\/script>/gi;
  const loaderRemoved = loaderRe.test(out);
  out = out.replace(loaderRe, '');

  return { html: out, restored, loaderRemoved };
}
