/**
 * Drive Clone/Swipe live-chat comments without Vidalytics.
 *
 * Original landers (profitsmachines.com/offer, mobileincome, …) only call
 * fireCommentsForVideoTime from the VSL player's timeupdate. After clone
 * that player often never mounts, so #clist stays empty. Splicing a clock
 * into the competitor script also fails when preview strips those scripts.
 *
 * This injects our own player: the TIMED array is copied into a standalone
 * <script type="text/javascript"> that prepends .citem rows on a wall clock.
 * Dedupes if the original engine later starts too.
 */

import { extractTimedComments, type TimedComment } from './bake-dynamic-comments';

const SCRIPT_ID = 'wasabi-live-comments';

function playerSource(entries: TimedComment[]): string {
  const json = JSON.stringify(entries).replace(/</g, '\\u003c');
  return `(function(){
  if (window.__wasabiLiveComments) return;
  window.__wasabiLiveComments = 1;
  var ITEMS = ${json};
  if (!ITEMS || !ITEMS.length) return;
  var AV = ['#cc0000','#0866ff','#e65100','#2e7d32','#6a1b9a','#ad1457','#0097a7','#5d4037','#1565c0','#f57f17'];
  function avColor(name) {
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) h += s.charCodeAt(i);
    return AV[h % AV.length];
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\\s+/);
    return p.length > 1 ? (p[0].charAt(0) + p[p.length - 1].charAt(0)).toUpperCase() : String(name || '').slice(0, 2).toUpperCase();
  }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function key(n, t) { return String(n || '') + '\\n' + String(t || ''); }
  var shown = {};
  var start = 0;
  function scanExisting(list) {
    var nodes = list.querySelectorAll('.citem');
    for (var i = 0; i < nodes.length; i++) {
      var nEl = nodes[i].querySelector('.cname');
      var tEl = nodes[i].querySelector('.ctext');
      var n = nEl ? nEl.textContent.replace(/HOST|You/g, '').trim() : '';
      var t = tEl ? tEl.textContent.trim() : '';
      if (n || t) shown[key(n, t)] = true;
    }
  }
  function render(c) {
    var list = document.getElementById('clist');
    if (!list) return false;
    var k = key(c.n, c.t);
    if (shown[k]) return true;
    var el = document.createElement('div');
    el.className = 'citem';
    el.setAttribute('data-wasabi-live', '1');
    el.setAttribute('data-ts', String(Date.now()));
    var host = !!c.isHost;
    el.innerHTML =
      '<div class="cav" style="background:' + avColor(c.n || '') + '">' + esc(initials(c.n || '')) + '</div>' +
      '<div class="cright"><div class="cbubble' + (host ? ' host-bub' : '') + '">' +
      '<div class="cname">' + esc(c.n || '') + (host ? '<span class="badge badge-host">HOST</span>' : '') + '</div>' +
      '<div class="ctext">' + esc(c.t || '') + '</div></div>' +
      '<div class="cmeta"><span class="ctime">just now</span>' +
      '<button type="button" class="clbtn">Like</button>' +
      '</div></div>';
    list.insertBefore(el, list.firstChild);
    shown[k] = true;
    var n = list.querySelectorAll('.citem').length;
    var cc = document.getElementById('cc-cnt');
    if (cc) cc.textContent = ' · ' + n + ' comment' + (n !== 1 ? 's' : '');
    var btn = el.querySelector('.clbtn');
    if (btn) btn.addEventListener('click', function() {
      btn.classList.toggle('clk');
      btn.textContent = btn.classList.contains('clk') ? 'Liked 👍' : 'Like';
    });
    return true;
  }
  function tick() {
    var list = document.getElementById('clist');
    if (!list) return;
    if (!start) start = Date.now();
    scanExisting(list);
    var elapsed = Date.now() - start;
    for (var i = 0; i < ITEMS.length; i++) {
      var c = ITEMS[i] || {};
      var d = typeof c.d === 'number' ? c.d : 0;
      if (d <= elapsed) render(c);
    }
  }
  function boot() {
    if (!document.getElementById('clist')) {
      setTimeout(boot, 250);
      return;
    }
    start = Date.now();
    tick();
    setInterval(tick, 250);
    setTimeout(function() {
      var list = document.getElementById('clist');
      if (!list || list.querySelector('.citem')) return;
      for (var i = 0; i < Math.min(8, ITEMS.length); i++) render(ITEMS[i]);
    }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;
}

export function injectLiveCommentClock(html: string, timed?: TimedComment[]): string {
  if (!html || typeof html !== 'string') return html;
  if (html.includes(`id="${SCRIPT_ID}"`)) return html;

  const entries = (timed && timed.length ? timed : extractTimedComments(html))
    .filter((c) => c && (c.t || c.n))
    .sort((a, b) => (a.d || 0) - (b.d || 0));
  if (entries.length === 0) return html;
  if (!/\bid=["']clist["']/i.test(html)) return html;

  const snippet =
    `<script type="text/javascript" id="${SCRIPT_ID}">${playerSource(entries)}</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${snippet}</body>`);
  }
  return html + snippet;
}
