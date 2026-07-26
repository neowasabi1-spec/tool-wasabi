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

  // Never run inside the Wasabi tool itself — the floating "Save" button would
  // overlap the app's own card actions (Save / Save template). We only want it
  // on external competitor pages.
  if (isWasabiTool()) return;

  const MIN_SIZE = 100; // ignore tiny icons / tracking pixels
  // Blob/data media is shipped inline (base64) in the save request, which must
  // stay under Netlify's ~6MB body limit. Bigger blob media can't be saved
  // directly — the user is steered to auto-scraping instead.
  const MAX_INLINE_BYTES = 4 * 1024 * 1024;

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
  const launchBtn = root.getElementById('launch');
  const launchLabel = root.getElementById('launchLabel');
  const bar = root.getElementById('bar');
  const selCountEl = root.getElementById('selCount');
  const importSelBtn = root.getElementById('importSel');

  let currentMedia = null; // element the button currently points at
  let hideTimer = null;
  let projectsCache = null;
  const competitorsCache = {}; // projectId -> [{id,name}]

  // ── Bulk selection ─────────────────────────────────────────────────────────
  let selectMode = false;
  // element -> { src, isVideo, name }. We snapshot the src at selection time
  // because ad-library pages virtualize/recycle nodes as you scroll.
  const selected = new Map();
  const prevOutline = new WeakMap();

  function renderBtn() {
    const isSel = currentMedia && selected.has(currentMedia);
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

  function toggleSelect(el) {
    if (!el) return;
    if (selected.has(el)) {
      selected.delete(el);
      restoreOutline(el);
    } else {
      selected.set(el, {
        src: currentSrc(el),
        isVideo: el.tagName === 'VIDEO',
        name: guessName(el),
      });
      applyOutline(el);
    }
    updateBar();
    renderBtn();
  }

  function updateBar() {
    selCountEl.textContent = String(selected.size);
    importSelBtn.disabled = selected.size === 0;
  }

  function setSelectMode(on) {
    selectMode = on;
    launchBtn.classList.toggle('on', on);
    launchLabel.textContent = on ? 'Selecting…' : 'Select creatives';
    bar.style.display = on ? 'flex' : 'none';
    if (!on) clearSelection();
    hideButton();
  }

  function clearSelection() {
    for (const el of selected.keys()) restoreOutline(el);
    selected.clear();
    updateBar();
  }

  launchBtn.addEventListener('click', () => setSelectMode(!selectMode));
  root.getElementById('clearSel').addEventListener('click', clearSelection);
  root.getElementById('exitSel').addEventListener('click', () => setSelectMode(false));
  importSelBtn.addEventListener('click', () => {
    if (selected.size > 0) openPopover(true);
  });

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
    if (isBatch && selected.size === 0) return;

    const media = isBatch ? null : currentMedia;
    const isVideo = media ? media.tagName === 'VIDEO' : false;
    const src = media ? currentSrc(media) : '';

    // Batch: single name-per-item makes no sense; hide it and title with count.
    nameRow.style.display = isBatch ? 'none' : 'block';
    const h4 = pop.querySelector('h4');
    if (h4) h4.textContent = isBatch
      ? `Import ${selected.size} creative${selected.size === 1 ? '' : 's'}`
      : 'Save to Competitor Library';

    popBadge.textContent = isBatch ? `${selected.size} selected` : (isVideo ? 'Video' : 'Image');
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
  async function buildCreativePayload(projectId, src, isVideo, name) {
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

    // For blob:/data: sources we must ship the bytes ourselves.
    if (!payload.mediaUrl && src) {
      const inline = await readInline(src);
      if (inline) {
        payload.mediaBase64 = inline.base64;
        payload.contentType = inline.type;
      } else if (isVideo) {
        return { error: 'video too large / streamed' };
      } else {
        return { error: 'could not read media' };
      }
    }
    return { payload };
  }

  async function importSelected(projectId, saveBtn) {
    const items = [...selected.values()];
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < items.length; i++) {
      setStatus(`<span class="spin"></span>Importing ${i + 1}/${items.length}…`, 'muted');
      const it = items[i];
      const built = await buildCreativePayload(projectId, it.src, it.isVideo, it.name);
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

    const built = await buildCreativePayload(projectId, src, isVideo, nameInput.value);
    if (built.error) {
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
