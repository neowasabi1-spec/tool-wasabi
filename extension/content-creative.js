/* Wasabi Saver — creative capture.
 *
 * Runs on every page. Shows a floating "Save" button over any image or video
 * the user hovers. Clicking it opens a small picker to choose the destination
 * project; the creative is then saved into that project's Competitor Library.
 *
 * Everything lives inside a Shadow DOM host so the host page's CSS can never
 * bleed in (and ours never bleeds out).
 */
// True when the current page is the Wasabi tool (prod origin, a Netlify deploy
// preview of the same site, or a local dev server). config.js runs first in
// the same content-script context, so WASABI_CONFIG is available here.
function isWasabiTool() {
  try {
    const cfg = (globalThis.WASABI_CONFIG && globalThis.WASABI_CONFIG.TOOL_ORIGIN) || '';
    const here = location.hostname;
    let toolHost = '';
    try { toolHost = new URL(cfg).hostname; } catch { /* ignore */ }

    if (toolHost && here === toolHost) return true;
    // Same Netlify site slug across deploy previews (e.g. deploy-preview-3--slug).
    const slug = toolHost.split('.')[0];
    if (slug && here.includes(slug)) return true;
    // Local dev server for the tool.
    if (here === 'localhost' || here === '127.0.0.1') return true;
    return false;
  } catch {
    return false;
  }
}

(function () {
  if (window.__wasabiCreativeSaver) return;
  window.__wasabiCreativeSaver = true;
  try { console.debug('[Wasabi] creative saver v1.6.12 (Select all)'); } catch { /* ignore */ }

  // Never run inside the Wasabi tool itself — the floating "Save" button would
  // overlap the app's own card actions (Save / Save template). We only want it
  // on external competitor pages.
  if (isWasabiTool()) return;

  const MIN_SIZE = 100; // ignore tiny icons / tracking pixels
  // Blob/data media is shipped inline (base64) in the save request, which must
  // stay under Netlify's ~6MB body limit. Bigger blob media can't be saved
  // directly — the user is steered to auto-scraping instead.
  const MAX_INLINE_BYTES = 4 * 1024 * 1024;

  // ── Video CDN resolution ───────────────────────────────────────────────────
  // The MAIN-world sniffer (inject-sniffer.js) posts real video URLs it sees on
  // the wire (any site, not just FB). We keep a short rolling list so that, when
  // the user saves a blob:/streamed video, we can hand the server a downloadable
  // URL instead of failing on the inline size cap. We prefer a "progressive"
  // file (mp4/webm/mov) the server can fetch directly; a "manifest" (HLS/DASH)
  // is only used as a last resort since it needs server-side muxing.
  const capturedVideoUrls = []; // { url, kind, t }
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__wasabiVideoUrl) return;
    capturedVideoUrls.push({
      url: String(d.__wasabiVideoUrl),
      kind: d.kind === 'manifest' ? 'manifest' : 'progressive',
      t: d.t || Date.now(),
    });
    if (capturedVideoUrls.length > 60) capturedVideoUrls.shift();
  });

  // Try to resolve the real CDN URL for a (blob) video. Nudges the element to
  // (re)stream so a fresh segment URL is captured, then returns the most recent
  // PROGRESSIVE capture (falling back to a manifest). Returns '' if nothing.
  async function resolveCdnUrl(mediaEl) {
    const before = capturedVideoUrls.length;
    try {
      if (mediaEl && typeof mediaEl.play === 'function') {
        const p = mediaEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch { /* ignore */ }
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (capturedVideoUrls.length > before) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!capturedVideoUrls.length) return '';
    for (let i = capturedVideoUrls.length - 1; i >= 0; i--) {
      if (capturedVideoUrls[i].kind === 'progressive') return capturedVideoUrls[i].url;
    }
    return capturedVideoUrls[capturedVideoUrls.length - 1].url; // manifest fallback
  }

  // ── Shadow host ──────────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'wasabi-creative-host';
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .btn {
        position: fixed; display: none; align-items: center; gap: 6px;
        background: #4f46e5; color: #fff; border: none; border-radius: 8px;
        padding: 7px 12px; font-size: 12px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,.35); z-index: 2147483647;
        transition: background .12s ease, transform .12s ease;
      }
      .btn:hover { background: #4338ca; transform: translateY(-1px); }
      .btn svg { width: 14px; height: 14px; }
      .pop {
        position: fixed; display: none; width: 280px; background: #fff; color: #0f172a;
        border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px;
        box-shadow: 0 18px 50px rgba(0,0,0,.35); z-index: 2147483647;
        max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain;
      }
      .pop h4 { margin: 0 0 2px; font-size: 13px; font-weight: 800; }
      .pop .sub { margin: 0 0 10px; font-size: 11px; color: #64748b; }
      .pop label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .04em; color: #64748b; margin: 10px 0 4px; }
      .pop select, .pop input {
        width: 100%; font-size: 13px; padding: 8px 9px; border: 1px solid #e2e8f0;
        border-radius: 8px; background: #f8fafc; color: #0f172a; outline: none;
      }
      .pop select:focus, .pop input:focus { border-color: #4f46e5; background: #fff; }
      .thumb { width: 100%; height: 90px; object-fit: cover; border-radius: 8px;
        background: #0f172a; margin-bottom: 4px; }
      .thumb.vid { display: flex; align-items: center; justify-content: center; }
      .thumb.vid svg { width: 30px; height: 30px; color: rgba(255,255,255,.7); }
      .pop .chk { display: flex; align-items: center; gap: 7px; margin: 12px 0 0;
        font-size: 12px; font-weight: 600; color: #0f172a; text-transform: none; letter-spacing: 0; cursor: pointer; }
      .pop .chk input { width: auto; }
      .scrapeBox { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px 10px; margin-top: 8px; background: #f8fafc; }
      .row { display: flex; gap: 8px; margin-top: 12px; }
      .row button { flex: 1; font-size: 12px; font-weight: 700; padding: 9px; border-radius: 8px; cursor: pointer; border: none; }
      .save { background: #4f46e5; color: #fff; }
      .save:hover { background: #4338ca; }
      .save:disabled { opacity: .6; cursor: default; }
      .cancel { background: #f1f5f9; color: #475569; }
      .cancel:hover { background: #e2e8f0; }
      /* Small, icon-only direct-download button sitting between Cancel and Save. */
      .dl { flex: 0 0 auto !important; background: #e2e8f0; color: #334155; display: flex;
        align-items: center; justify-content: center; padding: 9px 11px; }
      .dl:hover { background: #cbd5e1; }
      .dl:disabled { opacity: .6; cursor: default; }
      .dl svg { width: 15px; height: 15px; }
      .status { margin-top: 10px; font-size: 11px; min-height: 14px; }
      .status.ok { color: #16a34a; } .status.err { color: #dc2626; } .status.muted { color: #64748b; }
      .badge { position: absolute; top: 10px; left: 12px; font-size: 9px; font-weight: 800;
        text-transform: uppercase; letter-spacing: .05em; background: #eef2ff; color: #4f46e5;
        padding: 2px 7px; border-radius: 999px; }
      .spin { display:inline-block; width:11px; height:11px; border:2px solid currentColor;
        border-right-color:transparent; border-radius:50%; animation:sp .7s linear infinite; vertical-align:-1px; margin-right:5px; }
      @keyframes sp { to { transform: rotate(360deg); } }
      /* Bulk-select launcher + action bar */
      .launch { position: fixed; bottom: 16px; left: 16px; display: flex; align-items: center; gap: 6px;
        background: #0f172a; color: #fff; border: none; border-radius: 999px; padding: 9px 14px;
        font-size: 12px; font-weight: 800; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35);
        z-index: 2147483647; }
      .launch:hover { background: #1e293b; }
      .launch.on { background: #4f46e5; }
      .launch svg { width: 14px; height: 14px; }
      .bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: none;
        align-items: center; gap: 10px; background: #0f172a; color: #fff; border-radius: 14px;
        padding: 10px 12px 10px 16px; font-size: 12px; font-weight: 700;
        box-shadow: 0 12px 34px rgba(0,0,0,.45); z-index: 2147483647; }
      .bar b { color: #a5b4fc; }
      .bar button { font-size: 12px; font-weight: 800; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
      .bar .imp { background: #4f46e5; color: #fff; } .bar .imp:hover { background: #4338ca; }
      .bar .imp:disabled { opacity: .5; cursor: default; }
      .bar .all { background: #1e293b; color: #c7d2fe; } .bar .all:hover { background: #334155; }
      .bar .all:disabled { opacity: .6; cursor: default; }
      .bar .clr { background: #334155; color: #e2e8f0; } .bar .clr:hover { background: #475569; }
      .bar .done { background: transparent; color: #94a3b8; padding: 8px 6px; } .bar .done:hover { color: #e2e8f0; }
    </style>
    <button class="btn" id="btn" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
      Save
    </button>
    <div class="pop" id="pop">
      <span class="badge" id="popBadge">Image</span>
      <div id="thumbWrap"></div>
      <h4>Save to Competitor Library</h4>
      <p class="sub" id="popHost"></p>
      <label>Project</label>
      <select id="proj"></select>
      <label>Competitor</label>
      <select id="comp"></select>
      <input id="newcomp" type="text" placeholder="New competitor name" style="display:none;margin-top:6px;" />
      <label class="chk"><input id="autoScrape" type="checkbox" /> Enable daily auto-scraping</label>
      <div class="scrapeBox" id="scrapeOpts" style="display:none;">
        <label>Frequency</label>
        <select id="freq">
          <option value="daily">Daily</option>
          <option value="every_3_days">Every 3 days</option>
          <option value="every_7_days" selected>Every 7 days</option>
          <option value="every_14_days">Every 14 days</option>
        </select>
        <label>Ad Library URL</label>
        <input id="adsUrl" type="text" placeholder="https://www.facebook.com/ads/library/?..." />
      </div>
      <div id="nameRow">
        <label>Name</label>
        <input id="cname" type="text" placeholder="Creative name" />
      </div>
      <div class="row">
        <button class="cancel" id="cancel" type="button">Cancel</button>
        <button class="dl" id="doDownload" type="button" title="Download to your computer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        </button>
        <button class="save" id="doSave" type="button">Save</button>
      </div>
      <div class="status muted" id="status"></div>
    </div>
    <button class="launch" id="launch" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span id="launchLabel">Select creatives</span>
    </button>
    <div class="bar" id="bar">
      <span><b id="selCount">0</b> selected</span>
      <button class="all" id="selectAll" type="button" title="Scroll the whole page and select every ad (all pages)">Select all</button>
      <button class="imp" id="importSel" type="button" disabled>Import selected</button>
      <button class="clr" id="clearSel" type="button">Clear</button>
      <button class="done" id="exitSel" type="button">Done</button>
    </div>
  `;
  (document.documentElement || document.body).appendChild(host);

  const btn = root.getElementById('btn');
  const pop = root.getElementById('pop');
  const projSel = root.getElementById('proj');
  const compSel = root.getElementById('comp');
  const newCompInput = root.getElementById('newcomp');
  const autoScrape = root.getElementById('autoScrape');
  const scrapeOpts = root.getElementById('scrapeOpts');
  const freqSel = root.getElementById('freq');
  const adsUrlInput = root.getElementById('adsUrl');
  const nameInput = root.getElementById('cname');
  const statusEl = root.getElementById('status');
  const popBadge = root.getElementById('popBadge');
  const popHost = root.getElementById('popHost');
  const thumbWrap = root.getElementById('thumbWrap');
  const nameRow = root.getElementById('nameRow');
  const downloadBtn = root.getElementById('doDownload');
  const launchBtn = root.getElementById('launch');
  const launchLabel = root.getElementById('launchLabel');
  const bar = root.getElementById('bar');
  const selCountEl = root.getElementById('selCount');
  const importSelBtn = root.getElementById('importSel');
  const selectAllBtn = root.getElementById('selectAll');

  let currentMedia = null; // element the button currently points at
  let hideTimer = null;
  let projectsCache = null;
  const competitorsCache = {}; // projectId -> [{id,name}]

  // ── Bulk selection ─────────────────────────────────────────────────────────
  let selectMode = false;
  // element -> { src, isVideo, name }. We snapshot the src at selection time
  // because ad-library pages virtualize/recycle nodes as you scroll.
  const selected = new Map();
  // Bulk "Select all" captures live behind virtualization: keyed by normalized
  // src (not element) so an ad counts once even after its node is recycled and
  // survives when it scrolls out of view. Merged with `selected` at import time.
  const bulk = new Map(); // srcKey -> { src, isVideo, name }
  let scanning = false;
  const prevOutline = new WeakMap();

  const srcKey = (s) => String(s || '').split('#')[0];

  function renderBtn() {
    const isSel = currentMedia && isMediaSelected(currentMedia);
    if (selectMode) {
      btn.innerHTML = isSel
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Selected'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Select';
      btn.style.background = isSel ? '#16a34a' : '#4f46e5';
    } else {
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg> Save';
      btn.style.background = '';
    }
  }

  function applyOutline(el) {
    if (!prevOutline.has(el)) {
      prevOutline.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
    }
    el.style.outline = '3px solid #4f46e5';
    el.style.outlineOffset = '2px';
  }

  function restoreOutline(el) {
    const prev = prevOutline.get(el);
    if (prev) {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      prevOutline.delete(el);
    } else {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }
  }

  function guessName(el) {
    const g = (el.getAttribute('alt') || document.title || 'Creative').trim();
    return g.slice(0, 120);
  }

  function isMediaSelected(el) {
    if (!el) return false;
    if (selected.has(el)) return true;
    return bulk.has(srcKey(currentSrc(el)));
  }

  function toggleSelect(el) {
    if (!el) return;
    const src = currentSrc(el);
    const k = srcKey(src);
    if (selected.has(el)) {
      selected.delete(el);
      restoreOutline(el);
    } else if (bulk.has(k)) {
      // Was captured by "Select all" — a click deselects it.
      bulk.delete(k);
      restoreOutline(el);
    } else {
      selected.set(el, { src, isVideo: el.tagName === 'VIDEO', name: guessName(el) });
      applyOutline(el);
    }
    updateBar();
    renderBtn();
  }

  // Union count across manual (element) + bulk (src) selections, deduped by src.
  function selectedSrcKeys() {
    const set = new Set();
    for (const v of selected.values()) set.add(srcKey(v.src));
    return set;
  }
  function totalCount() {
    const inSel = selectedSrcKeys();
    let extra = 0;
    for (const k of bulk.keys()) if (!inSel.has(k)) extra++;
    return selected.size + extra;
  }

  function updateBar() {
    const n = totalCount();
    selCountEl.textContent = String(n);
    importSelBtn.disabled = n === 0;
  }

  function setSelectMode(on) {
    selectMode = on;
    launchBtn.classList.toggle('on', on);
    launchLabel.textContent = on ? 'Selecting…' : 'Select creatives';
    bar.style.display = on ? 'flex' : 'none';
    if (!on) { scanning = false; clearSelection(); }
    hideButton();
  }

  function clearSelection() {
    scanning = false;
    for (const el of selected.keys()) restoreOutline(el);
    selected.clear();
    bulk.clear();
    updateBar();
  }

  launchBtn.addEventListener('click', () => setSelectMode(!selectMode));
  root.getElementById('clearSel').addEventListener('click', clearSelection);
  root.getElementById('exitSel').addEventListener('click', () => setSelectMode(false));
  importSelBtn.addEventListener('click', () => {
    if (totalCount() > 0) openPopover(true);
  });
  selectAllBtn.addEventListener('click', () => {
    if (scanning) { scanning = false; return; } // second click = stop
    autoSelectAll();
  });

  // ── Select all (auto-scroll capture) ───────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Every eligible <img>/<video> currently in the DOM (excludes our own UI).
  function collectEligibleMedia() {
    const out = [];
    let nodes;
    try { nodes = document.querySelectorAll('img, video'); } catch { return out; }
    for (const el of nodes) {
      if (el === host || (host.contains && host.contains(el))) continue;
      if (isEligible(el)) out.push(el);
    }
    return out;
  }

  // Snapshot whatever is on screen right now into `bulk` (deduped by src, and
  // skipping anything already picked manually). Returns how many were new.
  function grabIntoBulk() {
    let added = 0;
    const inSel = selectedSrcKeys();
    for (const el of collectEligibleMedia()) {
      const src = currentSrc(el);
      if (!src) continue;
      const k = srcKey(src);
      if (inSel.has(k) || bulk.has(k)) continue;
      bulk.set(k, { src, isVideo: el.tagName === 'VIDEO', name: guessName(el) });
      added++;
    }
    return added;
  }

  // Walk the whole page top→bottom, capturing every ad as it lazy-loads. Ad
  // libraries virtualize their lists, so we snapshot srcs step by step instead
  // of relying on live element references. Click again to stop.
  async function autoSelectAll() {
    if (scanning) return;
    if (!selectMode) setSelectMode(true);
    scanning = true;
    const origLabel = 'Select all';
    const MAX_ITEMS = 2000;
    const MAX_STEPS = 500;
    const startY = window.scrollY;
    const setLbl = () => { selectAllBtn.textContent = scanning ? `Stop (${totalCount()})` : origLabel; };

    grabIntoBulk();
    updateBar();
    setLbl();

    let stagnant = 0;
    let lastHeight = document.documentElement.scrollHeight;
    for (let i = 0; i < MAX_STEPS && scanning; i++) {
      if (totalCount() >= MAX_ITEMS) break;
      window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.9)));
      await sleep(700);
      const added = grabIntoBulk();
      updateBar();
      setLbl();
      const h = document.documentElement.scrollHeight;
      const atBottom = window.innerHeight + window.scrollY >= h - 6;
      if (added === 0 && h === lastHeight && atBottom) {
        stagnant++;
        if (stagnant >= 4) break; // settled at the bottom, nothing new loading
      } else {
        stagnant = 0;
      }
      lastHeight = h;
    }

    grabIntoBulk(); // final sweep once things settle
    updateBar();
    window.scrollTo(0, startY);
    scanning = false;
    selectAllBtn.textContent = origLabel;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(r));
      } catch {
        resolve(null);
      }
    });
  }

  function isEligible(el) {
    if (!el) return false;
    if (el.tagName === 'VIDEO') return true;
    if (el.tagName === 'IMG') {
      const w = el.naturalWidth || el.width || el.getBoundingClientRect().width;
      const h = el.naturalHeight || el.height || el.getBoundingClientRect().height;
      return w >= MIN_SIZE && h >= MIN_SIZE && !!(el.currentSrc || el.src);
    }
    return false;
  }

  function positionButton() {
    if (!currentMedia || pop.style.display === 'block') return;
    const r = currentMedia.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) {
      hideButton();
      return;
    }
    renderBtn();
    btn.style.display = 'flex';
    // measure after display
    const bw = btn.offsetWidth || 78;
    let top = r.top + 8;
    let left = r.right - bw - 8;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    btn.style.top = top + 'px';
    btn.style.left = left + 'px';
  }

  function hideButton() {
    btn.style.display = 'none';
    currentMedia = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (pop.style.display !== 'block') hideButton();
    }, 350);
  }

  // Videos are frequently covered by overlay divs (player controls,
  // click-catchers), so a direct `closest('video')` on the hovered element
  // misses them. Fall back to scanning the element stack under the cursor —
  // elementsFromPoint returns covered elements too, including the <video>.
  function findMediaAtPoint(x, y) {
    let stack;
    try {
      stack = document.elementsFromPoint(x, y) || [];
    } catch {
      return null;
    }
    for (const node of stack) {
      if (!node || node === host) continue;
      if ((node.tagName === 'VIDEO' || node.tagName === 'IMG') && isEligible(node)) {
        return node;
      }
    }
    return null;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      let el = t && t.closest ? t.closest('img, video') : null;
      if ((!el || !isEligible(el)) && typeof e.clientX === 'number') {
        el = findMediaAtPoint(e.clientX, e.clientY);
      }
      if (el && isEligible(el)) {
        clearTimeout(hideTimer);
        currentMedia = el;
        positionButton();
      }
    },
    true,
  );

  // Keep the button anchored while moving across a video's overlay controls.
  document.addEventListener(
    'mousemove',
    (e) => {
      if (pop.style.display === 'block') return;
      if (!currentMedia) return;
      const r = currentMedia.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) clearTimeout(hideTimer);
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    () => {
      if (pop.style.display !== 'block') scheduleHide();
    },
    true,
  );

  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener('mouseleave', scheduleHide);

  window.addEventListener('scroll', () => positionButton(), true);
  window.addEventListener('resize', () => {
    if (pop.style.display === 'block') positionPopover();
    else positionButton();
  });

  // ── Popover ────────────────────────────────────────────────────────────
  function currentSrc(el) {
    if (!el) return '';
    if (el.tagName === 'VIDEO') {
      if (el.currentSrc) return el.currentSrc;
      if (el.src) return el.src;
      const s = el.querySelector('source[src]');
      return s ? s.src : '';
    }
    return el.currentSrc || el.src || '';
  }

  function setStatus(html, cls) {
    statusEl.className = 'status ' + (cls || 'muted');
    statusEl.innerHTML = html || '';
  }

  async function loadProjects() {
    if (projectsCache) return projectsCache;
    const res = await sendMessage({ type: 'GET_PROJECTS' });
    if (!res || !res.ok) {
      projectsCache = null;
      return null;
    }
    projectsCache = res.projects || [];
    return projectsCache;
  }

  async function loadCompetitors(projectId) {
    if (!projectId) return [];
    if (competitorsCache[projectId]) return competitorsCache[projectId];
    const res = await sendMessage({ type: 'GET_COMPETITORS', projectId });
    const list = res && res.ok ? res.competitors || [] : [];
    competitorsCache[projectId] = list;
    return list;
  }

  function domainName() {
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      return 'site';
    }
  }

  async function populateCompetitors(projectId) {
    compSel.innerHTML = '<option value="">Auto (from site domain)</option>';
    const list = await loadCompetitors(projectId);
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name;
      compSel.appendChild(opt);
    }
    const nw = document.createElement('option');
    nw.value = '__new__';
    nw.textContent = '+ New competitor…';
    compSel.appendChild(nw);
    newCompInput.style.display = 'none';
    newCompInput.value = '';
  }

  compSel.addEventListener('change', () => {
    if (compSel.value === '__new__') {
      newCompInput.style.display = 'block';
      newCompInput.placeholder = 'New competitor name (default: ' + domainName() + ')';
      newCompInput.focus();
    } else {
      newCompInput.style.display = 'none';
    }
  });

  autoScrape.addEventListener('change', () => {
    scrapeOpts.style.display = autoScrape.checked ? 'block' : 'none';
    if (autoScrape.checked && !adsUrlInput.value) adsUrlInput.value = location.href;
    positionPopover();
  });

  projSel.addEventListener('change', () => {
    populateCompetitors(projSel.value);
  });

  // Place the popover next to the Save button, clamped so the whole box stays
  // on-screen. Height is measured live (content grows when auto-scrape opens),
  // and the box scrolls internally if it can't fit.
  function positionPopover() {
    const margin = 8;
    const pw = pop.offsetWidth || 280;
    const ph = pop.offsetHeight || 300;

    // Batch mode has no anchor button — center the popover.
    if (pop.__batch) {
      let left = (innerWidth - pw) / 2;
      if (left < margin) left = margin;
      let top = (innerHeight - ph) / 2;
      if (top < margin) top = margin;
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      return;
    }

    const br = btn.getBoundingClientRect();
    let left = Math.min(br.left, innerWidth - pw - margin);
    if (left < margin) left = margin;

    let top = br.bottom + 6;
    if (top + ph > innerHeight - margin) top = innerHeight - margin - ph;
    if (top < margin) top = margin;

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  async function openPopover(batch) {
    const isBatch = batch === true;
    pop.__batch = isBatch;
    if (!isBatch && !currentMedia) return;
    const batchCount = totalCount();
    if (isBatch && batchCount === 0) return;

    const media = isBatch ? null : currentMedia;
    const isVideo = media ? media.tagName === 'VIDEO' : false;
    const src = media ? currentSrc(media) : '';

    // Batch: single name-per-item makes no sense; hide it and title with count.
    nameRow.style.display = isBatch ? 'none' : 'block';
    // Direct download is a single-item action; hide it while batch-importing.
    downloadBtn.style.display = isBatch ? 'none' : 'flex';
    const h4 = pop.querySelector('h4');
    if (h4) h4.textContent = isBatch
      ? `Import ${batchCount} creative${batchCount === 1 ? '' : 's'}`
      : 'Save to Competitor Library';

    popBadge.textContent = isBatch ? `${batchCount} selected` : (isVideo ? 'Video' : 'Image');
    try {
      popHost.textContent = new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      popHost.textContent = '';
    }

    // Thumbnail (single only)
    thumbWrap.innerHTML = '';
    if (isBatch) {
      const d = document.createElement('div');
      d.className = 'thumb vid';
      d.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
      thumbWrap.appendChild(d);
    } else if (isVideo) {
      const d = document.createElement('div');
      d.className = 'thumb vid';
      d.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      thumbWrap.appendChild(d);
    } else if (src) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = src;
      thumbWrap.appendChild(img);
    }

    // Default name (single only)
    if (!isBatch) nameInput.value = guessName(media);

    // Reset auto-scrape controls; prefill the Ad Library URL with this page.
    autoScrape.checked = false;
    scrapeOpts.style.display = 'none';
    adsUrlInput.value = location.href;

    pop.style.display = 'block';
    btn.style.display = 'none';
    positionPopover();

    setStatus('<span class="spin"></span>Loading projects…', 'muted');
    const projects = await loadProjects();
    if (!projects) {
      setStatus('Not connected. Open Wasabi, log in, then retry.', 'err');
      projSel.innerHTML = '';
      return;
    }
    if (projects.length === 0) {
      setStatus('No projects yet — create one in Wasabi first.', 'err');
      projSel.innerHTML = '';
      return;
    }
    projSel.innerHTML = '';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      projSel.appendChild(opt);
    }
    const { wasabi_last_project } = await chrome.storage.local
      .get('wasabi_last_project')
      .catch(() => ({}));
    if (wasabi_last_project && projects.some((p) => p.id === wasabi_last_project)) {
      projSel.value = wasabi_last_project;
    }
    await populateCompetitors(projSel.value);
    setStatus('', 'muted');

    // Stash the media + src for the save handler.
    pop.__media = media;
    pop.__src = src;
    pop.__isVideo = isVideo;
  }

  function closePopover() {
    pop.style.display = 'none';
    pop.__media = null;
    pop.__batch = false;
    nameRow.style.display = 'block';
    setStatus('', 'muted');
    hideButton();
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (selectMode) {
      toggleSelect(currentMedia);
    } else {
      openPopover();
    }
  });
  root.getElementById('cancel').addEventListener('click', closePopover);

  // Close when clicking outside the popover.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (pop.style.display !== 'block') return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(pop) && !path.includes(host)) closePopover();
    },
    true,
  );

  // Read blob:/data: media into base64 (page context can read its own blobs).
  async function readInline(src) {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      if (blob.size > MAX_INLINE_BYTES) return null;
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve({ base64: String(fr.result), type: blob.type });
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  // Apply the shared destination controls (competitor + auto-scrape) onto a payload.
  function applyDestination(payload) {
    if (compSel.value === '__new__') {
      payload.brandName = newCompInput.value.trim() || domainName();
    } else if (compSel.value) {
      payload.brandId = Number(compSel.value);
    }
    if (autoScrape.checked) {
      payload.autoScrape = true;
      payload.frequency = freqSel.value;
      payload.adsLibraryUrl = adsUrlInput.value.trim() || location.href;
    }
  }

  // Build a SAVE_CREATIVE payload for one media. Returns { payload } or { error }.
  async function buildCreativePayload(projectId, src, isVideo, name, mediaEl) {
    const payload = {
      type: 'SAVE_CREATIVE',
      projectId,
      pageUrl: location.href,
      pageTitle: document.title || '',
      mediaUrl: /^https?:\/\//i.test(src) ? src : '',
      mediaType: isVideo ? 'video' : 'image',
      name: (name || '').trim(),
    };
    applyDestination(payload);

    // For blob:/data: sources we must get the bytes to the server somehow.
    if (!payload.mediaUrl && src) {
      // Streamed videos (blob:/MSE — TikTok/FB/IG) can't be shipped inline and
      // the server can't fetch the CDN URL (needs the browser's cookies +
      // Referer). Bail out to the background download+upload path in doSave.
      if (isVideo) return { error: 'video streamed' };
      const inline = await readInline(src);
      if (inline) {
        payload.mediaBase64 = inline.base64;
        payload.contentType = inline.type;
      } else {
        return { error: 'could not read media' };
      }
    }
    return { payload };
  }

  // Read same-origin blob:/data: bytes as a Blob (any size). Returns null for
  // unreadable MSE streams — those are handled by resolving the CDN URL and
  // letting the background fetch it (host permissions bypass CORS).
  async function getMediaBlob(src) {
    try {
      const r = await fetch(src);
      if (r.ok) {
        const b = await r.blob();
        if (b && b.size) return b;
      }
    } catch { /* ignore */ }
    return null;
  }

  // Pull a real video URL out of the page for streamed (blob/MSE) videos.
  // TikTok/IG embed the playable URL in a rehydration <script>; otherwise fall
  // back to whatever the network sniffer captured.
  function resolveVideoUrlFromDom() {
    try {
      const ids = ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__'];
      for (const id of ids) {
        const s = document.getElementById(id);
        const txt = s && s.textContent;
        if (!txt) continue;
        const m = txt.match(/"(?:playAddr|downloadAddr|play_addr|download_addr)":"(https?:[^"]+)"/i);
        if (m && m[1]) {
          return m[1]
            .replace(/\\u002F/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003D/gi, '=')
            .replace(/\\u003F/gi, '?')
            .replace(/\\\//g, '/')
            .replace(/\\/g, '');
        }
      }
    } catch { /* ignore */ }
    return '';
  }

  async function resolveVideoUrl(mediaEl, isVideo) {
    const dom = resolveVideoUrlFromDom();
    if (dom) return dom;
    if (isVideo) return await resolveCdnUrl(mediaEl);
    return '';
  }

  // Upload the bytes straight to storage via a signed URL (no size limit), then
  // register the creative from the stored path. Bypasses the ~6MB save-request
  // body limit that triggers the "video too large" message.
  async function saveViaSignedUpload(projectId, blob, isVideo, name) {
    const contentType = blob.type || (isVideo ? 'video/mp4' : 'image/jpeg');
    const sign = await sendMessage({
      type: 'SIGN_CREATIVE',
      projectId,
      contentType,
      mediaType: isVideo ? 'video' : 'image',
    });
    if (!sign || !sign.ok || !sign.uploadUrl) {
      return { ok: false, error: (sign && sign.error) || 'Could not sign upload' };
    }
    const up = await fetch(sign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
      body: blob,
    });
    if (!up.ok) return { ok: false, error: `Upload failed (${up.status})` };
    const payload = {
      type: 'SAVE_CREATIVE',
      projectId,
      pageUrl: location.href,
      pageTitle: document.title || '',
      mediaType: isVideo ? 'video' : 'image',
      name: (name || '').trim(),
      storagePath: sign.path,
      contentType: sign.contentType || contentType,
    };
    applyDestination(payload);
    return await sendMessage(payload);
  }

  async function importSelected(projectId, saveBtn) {
    // Merge manual (element) + bulk (src) picks, deduped by src.
    const items = [];
    const seen = new Set();
    for (const [el, v] of selected.entries()) {
      const k = srcKey(v.src);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ el, ...v });
    }
    for (const [k, v] of bulk.entries()) {
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ el: null, ...v });
    }
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < items.length; i++) {
      setStatus(`<span class="spin"></span>Importing ${i + 1}/${items.length}…`, 'muted');
      const it = items[i];
      const built = await buildCreativePayload(projectId, it.src, it.isVideo, it.name, it.el);
      if (built.error) { fail++; continue; }
      const res = await sendMessage(built.payload);
      if (res && res.ok) ok++;
      else fail++;
    }
    await chrome.storage.local.set({ wasabi_last_project: projectId }).catch(() => {});
    saveBtn.disabled = false;
    setStatus(
      `Imported ${ok}/${items.length}${fail ? ` · ${fail} skipped (large/streamed videos)` : ''}`,
      fail && !ok ? 'err' : 'ok',
    );
    if (ok > 0) {
      clearSelection();
      setTimeout(() => { closePopover(); setSelectMode(false); }, 2200);
    }
  }

  // ── Direct download ──────────────────────────────────────────────────────
  function extForType(type, isVideo) {
    if (type) {
      const sub = String(type).split('/')[1];
      if (sub) return sub.split(';')[0].replace('quicktime', 'mov').replace('jpeg', 'jpg');
    }
    return isVideo ? 'mp4' : 'jpg';
  }

  function buildFilename(name, src, type, isVideo) {
    const base =
      (name || 'creative').trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '_').slice(0, 80) ||
      'creative';
    let ext = '';
    try {
      const p = new URL(src, location.href).pathname;
      const m = p.match(/\.([a-z0-9]{2,4})(?:$|\?)/i);
      if (m) ext = m[1].toLowerCase();
    } catch {
      /* blob:/data: — no path */
    }
    if (!ext) ext = extForType(type, isVideo);
    return `${base}.${ext}`;
  }

  // blob:/data: media is same-origin to the page, so an anchor download works
  // with no size limit and no CORS — no need to route through the service worker.
  function anchorDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '';
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1500);
  }

  downloadBtn.addEventListener('click', async () => {
    const src = pop.__src;
    const isVideo = pop.__isVideo;
    if (!src) {
      setStatus('Nothing to download here.', 'err');
      return;
    }
    downloadBtn.disabled = true;
    setStatus('<span class="spin"></span>Downloading…', 'muted');
    try {
      if (/^https?:\/\//i.test(src)) {
        // Cross-origin http(s): the SW's chrome.downloads bypasses CORS.
        const res = await sendMessage({
          type: 'DOWNLOAD_MEDIA',
          url: src,
          filename: buildFilename(nameInput.value, src, '', isVideo),
        });
        setStatus(res && res.ok ? 'Download started ✓' : (res && res.error) || 'Download failed.', res && res.ok ? 'ok' : 'err');
      } else {
        // blob:/data: — download in-page (no size cap).
        anchorDownload(src, buildFilename(nameInput.value, src, '', isVideo));
        setStatus('Download started ✓', 'ok');
      }
    } catch (e) {
      setStatus(String((e && e.message) || 'Download failed.'), 'err');
    } finally {
      downloadBtn.disabled = false;
    }
  });

  root.getElementById('doSave').addEventListener('click', async () => {
    const projectId = projSel.value;
    if (!projectId) {
      setStatus('Pick a project first.', 'err');
      return;
    }
    const saveBtn = root.getElementById('doSave');
    saveBtn.disabled = true;

    // Batch import path.
    if (pop.__batch) {
      await importSelected(projectId, saveBtn);
      return;
    }

    // Single save path.
    const src = pop.__src;
    const isVideo = pop.__isVideo;
    if (!pop.__media) { saveBtn.disabled = false; return; }
    setStatus('<span class="spin"></span>Saving…', 'muted');

    const built = await buildCreativePayload(projectId, src, isVideo, nameInput.value, pop.__media);
    if (built.error) {
      // Inline shipping failed (too large / unreadable). No size cap from here.
      setStatus('<span class="spin"></span>Uploading large file…', 'muted');

      const finish = (res) => {
        saveBtn.disabled = false;
        if (res && res.ok) {
          chrome.storage.local.set({ wasabi_last_project: projectId }).catch(() => {});
          setStatus(res.message || 'Saved to Competitor Library ✓', 'ok');
          setTimeout(closePopover, res.message ? 2600 : 1100);
        } else {
          setStatus((res && res.error) || 'Save failed.', 'err');
        }
      };

      // 1) Readable blob:/data: → we have the bytes here; upload via signed URL.
      const blob = await getMediaBlob(src);
      if (blob) {
        finish(await saveViaSignedUpload(projectId, blob, isVideo, nameInput.value));
        return;
      }

      // 2) Streamed (MSE) video: resolve the real CDN/page URL and let the
      // background fetch it (host permissions bypass CORS) + upload to storage.
      const url = await resolveVideoUrl(pop.__media, isVideo);
      if (url) {
        const dest = {};
        applyDestination(dest);
        finish(
          await sendMessage({
            type: 'FETCH_AND_UPLOAD',
            projectId,
            url,
            isVideo,
            name: nameInput.value,
            pageUrl: location.href,
            pageTitle: document.title || '',
            ...dest,
          }),
        );
        return;
      }

      setStatus(
        isVideo
          ? 'Video too large to save directly — enable auto-scraping with the Ad Library URL instead.'
          : 'Could not read this media (too large or protected).',
        'err',
      );
      saveBtn.disabled = false;
      return;
    }

    const res = await sendMessage(built.payload);
    saveBtn.disabled = false;
    if (res && res.ok) {
      await chrome.storage.local.set({ wasabi_last_project: projectId }).catch(() => {});
      setStatus(res.message || 'Saved to Competitor Library ✓', 'ok');
      setTimeout(closePopover, res.message ? 2600 : 1100);
    } else {
      setStatus((res && res.error) || 'Save failed.', 'err');
    }
  });
})();
