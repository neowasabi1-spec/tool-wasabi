/**
 * Live-chat comment engines (profitsmachines / mobileincome TIMED array)
 * only call fireCommentsForVideoTime from the VSL player's timeupdate.
 * After clone, Vidalytics/vTurb often never mounts (srcdoc origin, embed
 * domain lock, stripped loader) so #clist stays empty.
 *
 * Splice a wall-clock fallback into the same <script> as handleVideoTick
 * so it can call the closed-over renderer. If the player starts ticking,
 * the clock stops and the original video timeline stays in charge.
 *
 * Idempotent. No-op on pages without that engine.
 */

const MARKER = '__wasabiCommentClock';

const CLOCK_SNIPPET = `
/*${MARKER}*/
(function(){
  try {
    var origTick = (typeof handleVideoTick === 'function')
      ? handleVideoTick
      : (typeof fireCommentsForVideoTime === 'function')
        ? fireCommentsForVideoTime
        : null;
    if (!origTick) return;
    var start = Date.now();
    var drivenByPlayer = false;
    var fromClock = false;
    if (typeof handleVideoTick === 'function') {
      handleVideoTick = function(t) {
        if (!fromClock && typeof t === 'number' && t > 0.2) drivenByPlayer = true;
        return origTick.apply(this, arguments);
      };
    }
    document.addEventListener('timeupdate', function(ev) {
      var el = ev && ev.target;
      if (el && el.tagName === 'VIDEO' && el.currentTime > 0.2) drivenByPlayer = true;
    }, true);
    setTimeout(function() {
      if (drivenByPlayer) return;
      var iv = setInterval(function() {
        if (drivenByPlayer) { clearInterval(iv); return; }
        try {
          fromClock = true;
          origTick((Date.now() - start) / 1000);
        } catch (e) { clearInterval(iv); }
        finally { fromClock = false; }
      }, 250);
    }, 1200);
  } catch (e) {}
})();
`;

export function injectLiveCommentClock(html: string): string {
  if (!html || typeof html !== 'string') return html;
  if (html.includes(MARKER)) return html;
  if (
    !/function\s+handleVideoTick\s*\(/.test(html) &&
    !/function\s+fireCommentsForVideoTime\s*\(/.test(html)
  ) {
    return html;
  }

  return html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (full, attrs: string, body: string) => {
      if (/\bsrc\s*=/.test(attrs)) return full;
      if (
        !/function\s+handleVideoTick\s*\(/.test(body) &&
        !/function\s+fireCommentsForVideoTime\s*\(/.test(body)
      ) {
        return full;
      }
      if (body.includes(MARKER)) return full;
      const trimmed = body.replace(/\s+$/, '');
      const iifeEnd = trimmed.match(/(\}\)\s*\(\s*\)\s*;)\s*$/);
      const next = iifeEnd
        ? trimmed.slice(0, trimmed.length - iifeEnd[1].length) + CLOCK_SNIPPET + iifeEnd[1]
        : body + CLOCK_SNIPPET;
      return `<script${attrs}>${next}</script>`;
    },
  );
}
