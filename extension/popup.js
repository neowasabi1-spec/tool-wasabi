/* Wasabi Saver — popup logic. */
const CFG = globalThis.WASABI_CONFIG || {};
const TOOL = (CFG.TOOL_ORIGIN || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const els = {
  authState: $('authState'),
  notConnected: $('notConnected'),
  openTool: $('openTool'),
  form: $('form'),
  destination: $('destination'),
  projectField: $('projectField'),
  project: $('project'),
  name: $('name'),
  categoryField: $('categoryField'),
  category: $('category'),
  newCategory: $('newCategory'),
  typeField: $('typeField'),
  folder: $('folder'),
  addTypeBtn: $('addTypeBtn'),
  newType: $('newType'),
  tagsField: $('tagsField'),
  tags: $('tags'),
  tagSuggestions: $('tagSuggestions'),
  shotDesktop: $('shotDesktop'),
  shotMobile: $('shotMobile'),
  funnelMode: $('funnelMode'),
  pageUrl: $('pageUrl'),
  bulkMode: $('bulkMode'),
  bulkBox: $('bulkBox'),
  bulkScan: $('bulkScan'),
  bulkUrls: $('bulkUrls'),
  bulkCount: $('bulkCount'),
  bulkResume: $('bulkResume'),
  save: $('save'),
  status: $('status'),
};

let activeTab = null;
let knownSavedUrls = [];

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(r);
    });
  });
}

function setStatus(html, cls) {
  els.status.className = 'status' + (cls ? ' ' + cls : '');
  els.status.innerHTML = html;
}

function isCapturableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function revealForm() {
  els.form && els.form.classList.add('ready');
}

async function init() {
  if (!TOOL || TOOL.includes('YOUR-TOOL')) {
    els.authState.textContent = 'not configured';
    els.authState.className = 'auth bad';
    setStatus('Edit <code>config.js</code> with your tool + Supabase values, then reload the extension.', 'err');
    revealForm();
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  if (activeTab) {
    els.pageUrl.textContent = activeTab.url || '';
    els.name.value = activeTab.title || '';
  }

  let auth = await sendMessage({ type: 'AUTH_STATE' });
  if (!auth || !auth.connected) {
    // Try to auto-connect by reading the session from an already-open tool tab.
    await tryAutoConnect();
    auth = await sendMessage({ type: 'AUTH_STATE' });
  }
  if (!auth || !auth.connected) {
    els.authState.textContent = 'not connected';
    els.authState.className = 'auth bad';
    els.notConnected.classList.remove('hidden');
    els.save.disabled = true;
    revealForm();
    return;
  }

  els.authState.textContent = auth.email || 'connected';
  els.authState.className = 'auth ok';

  if (!activeTab || !isCapturableUrl(activeTab.url)) {
    setStatus('This page can’t be captured (browser/internal page). Open a normal website.', 'err');
    els.save.disabled = true;
  } else {
    els.save.disabled = false;
  }

  loadFolders();

  // Destination selector: Template archive (default) vs a Project's
  // Competitor Landings. Projects are loaded lazily on first switch.
  let projectsLoaded = false;
  const syncDestination = async () => {
    const toProject = els.destination.value === 'project';
    // Project → only the project picker. Template → only template settings.
    els.projectField.classList.toggle('hidden', !toProject);
    [els.categoryField, els.typeField, els.tagsField].forEach(
      (f) => f && f.classList.toggle('hidden', toProject),
    );
    els.save.textContent = toProject ? 'Save to Competitor Landings' : 'Save to Wasabi';
    if (toProject && !projectsLoaded) {
      projectsLoaded = true;
      await loadProjects();
    }
  };
  els.destination.addEventListener('change', syncDestination);
  syncDestination();
  revealForm();

  if (els.bulkMode && /adspend/i.test((activeTab && activeTab.url) || '')) {
    els.bulkMode.checked = true;
    syncBulkUi();
    scanListingUrls();
  }

  // A funnel walk / bulk import runs in the background; if one is in progress, show it.
  resumeFunnelWalkIfRunning();
  resumeBulkIfRunning();
}

async function loadProjects() {
  try {
    const res = await sendMessage({ type: 'GET_PROJECTS' });
    const projects = (res && res.ok && Array.isArray(res.projects)) ? res.projects : [];
    els.project.innerHTML = '';
    if (!projects.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No projects found';
      els.project.appendChild(opt);
      return;
    }
    const last = (await chrome.storage.local.get('wasabi_last_project'))?.wasabi_last_project;
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name || 'Untitled';
      if (last && String(p.id) === String(last)) opt.selected = true;
      els.project.appendChild(opt);
    }
  } catch (e) {
    console.warn('loadProjects failed', e);
    els.project.innerHTML = '<option value="">Could not load projects</option>';
  }
}

// Reads `wasabi_session` from an open tab on the tool origin and hands it to
// the background worker — so the extension connects itself without the user
// having to reload the tool after install.
async function tryAutoConnect() {
  try {
    const tabs = await chrome.tabs.query({ url: TOOL + '/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            try {
              const raw = window.localStorage.getItem('wasabi_session');
              return raw ? JSON.parse(raw) : null;
            } catch {
              return null;
            }
          },
        });
        const s = results && results[0] && results[0].result;
        if (s && s.access_token) {
          await sendMessage({ type: 'WASABI_SESSION', session: s });
          return true;
        }
      } catch {
        /* tab not scriptable; try next */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function loadFolders() {
  try {
    const token = (await sendMessage({ type: 'GET_TOKEN' }))?.token;
    if (!token) return;
    const res = await fetch(`${TOOL}/api/extension/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if ((data.folders || []).length) {
      els.folder.innerHTML = '';
      const preferAdvertorial = /adspend/i.test((activeTab && activeTab.url) || '');
      const prefer = preferAdvertorial ? 'advertorial' : 'landing';
      let picked = false;
      for (const f of data.folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name;
        if (!picked && f.id === prefer) {
          opt.selected = true;
          picked = true;
        }
        els.folder.appendChild(opt);
      }
      if (!picked) {
        for (const opt of els.folder.options) {
          if (opt.value === 'landing') { opt.selected = true; break; }
        }
      }
    }
    for (const t of data.tags || []) {
      const opt = document.createElement('option');
      opt.value = t;
      els.tagSuggestions.appendChild(opt);
    }
    if (els.category) {
      els.category.innerHTML = '<option value="">— No category —</option>';
      for (const c of data.categories || []) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        els.category.appendChild(opt);
      }
    }
    knownSavedUrls = Array.isArray(data.savedUrls) ? data.savedUrls : [];
  } catch (e) {
    console.warn('loadFolders failed', e);
  }
}

async function captureHtml(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-capture.js'],
  });
  const r = results && results[0] && results[0].result;
  if (!r || !r.ok) throw new Error((r && r.error) || 'Could not read the page');
  return r;
}

// Convert a "data:image/png;base64,…" URL into a Blob so it can be PUT to
// storage without inflating it back through JSON.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Ask the tool for a signed upload URL, then push the screenshot bytes straight
// to storage. Returns the stored path to hand to save-page.
async function uploadShot(token, variant, dataUrl) {
  const contentType = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'image/png';
  const signRes = await fetch(`${TOOL}/api/extension/sign-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ variant, contentType }),
  });
  const sj = await signRes.json().catch(() => ({}));
  if (!signRes.ok || !sj.uploadUrl) throw new Error(sj.error || `sign failed (${signRes.status})`);
  const up = await fetch(sj.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': sj.contentType || contentType, 'x-upsert': 'true' },
    body: dataUrlToBlob(dataUrl),
  });
  if (!up.ok) throw new Error(`upload failed (${up.status})`);
  return sj.path;
}

// Capture desktop/mobile screenshots of a tab and upload them straight to
// storage via signed URLs. Returns { desktop?, mobile? } storage paths (never
// throws — screenshots are best-effort so a save is never lost over them).
async function captureAndUploadShots(token, tabId, onStatus) {
  const paths = {};
  if (!els.shotDesktop.checked && !els.shotMobile.checked) return paths;
  if (onStatus) onStatus('Taking screenshots…');
  const shots = await sendMessage({ type: 'CAPTURE_SHOTS', tabId });
  if (!shots || !shots.ok) {
    console.warn('screenshots failed:', shots && shots.error);
    return paths;
  }
  const pending = [];
  if (els.shotDesktop.checked && shots.desktop) pending.push(['desktop', shots.desktop]);
  if (els.shotMobile.checked && shots.mobile) pending.push(['mobile', shots.mobile]);
  if (pending.length && onStatus) onStatus('Uploading screenshots…');
  for (const [variant, dataUrl] of pending) {
    try {
      paths[variant] = await uploadShot(token, variant, dataUrl);
    } catch (e) {
      console.warn(`screenshot ${variant} upload failed:`, (e && e.message) || e);
    }
  }
  return paths;
}

// POST one captured page to save-page. Returns the parsed response data.
async function savePage(token, body) {
  const res = await fetch(`${TOOL}/api/extension/save-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Save failed (${res.status})`);
  return data;
}

function slugifyType(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function showNewTypeInput() {
  if (!els.newType) return;
  els.newType.classList.remove('hidden');
  els.newType.focus();
}

function commitNewType() {
  if (!els.newType) return;
  const label = els.newType.value.trim();
  if (!label) return;
  const value = slugifyType(label);
  if (!value) return;
  let found = false;
  for (const opt of els.folder.options) {
    if (opt.value === value) {
      opt.selected = true;
      found = true;
      break;
    }
  }
  if (!found) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    opt.selected = true;
    els.folder.appendChild(opt);
  }
  els.newType.value = '';
  els.newType.classList.add('hidden');
}

function resolveSavePageType() {
  const typed = (els.newType && els.newType.value.trim()) || '';
  if (typed) {
    return { pageType: slugifyType(typed) || 'landing', pageTypeLabel: typed };
  }
  return { pageType: els.folder.value || 'landing', pageTypeLabel: undefined };
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pageIdentity(raw) {
  try {
    const x = new URL(String(raw || '').trim());
    const host = x.hostname.replace(/^www\./i, '').toLowerCase();
    const path = (x.pathname || '/').replace(/\/+$/, '') || '/';
    return `${x.protocol}//${host}${path.toLowerCase()}`;
  } catch {
    return String(raw || '').toLowerCase().replace(/\/+$/, '').split('?')[0];
  }
}

async function onSave() {
  els.save.disabled = true;
  try {
    const token = (await sendMessage({ type: 'GET_TOKEN' }))?.token;
    if (!token) {
      setStatus('Session expired. Open the tool, log in, and reopen this popup.', 'err');
      els.notConnected.classList.remove('hidden');
      return;
    }

    const toProject = els.destination.value === 'project';
    const projectId = toProject ? (els.project.value || '') : '';
    if (toProject && !projectId) {
      setStatus('Select a project first.', 'err');
      return;
    }

    // Funnel mode: run the whole walk in the BACKGROUND so it survives the
    // popup being closed/reopened. The popup only shows live progress.
    if (els.funnelMode.checked) {
      await startBackgroundFunnelWalk(toProject ? projectId : null);
      return;
    }

    if (els.bulkMode && els.bulkMode.checked) {
      await startBackgroundBulk(toProject ? projectId : null);
      return;
    }

    setStatus('<span class="spinner"></span>Reading page…');
    const page = await captureHtml(activeTab.id);

    // Capture screenshots, then upload them STRAIGHT to storage via signed URLs.
    // Full-page PNGs are megabytes each; sending them inline in the save JSON
    // blew past the 6MB serverless body limit and failed the whole save with a
    // 413. Now only their storage paths travel in the save request.
    const screenshotPaths = await captureAndUploadShots(token, activeTab.id, (m) =>
      setStatus(`<span class="spinner"></span>${m}`),
    );

    setStatus(`<span class="spinner"></span>Saving to ${toProject ? 'project' : 'archive'}…`);
    const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
    // A freshly typed category / type wins over the dropdown selection.
    const category = (els.newCategory.value.trim() || els.category.value || '').slice(0, 60);
    const { pageType, pageTypeLabel } = resolveSavePageType();
    const body = {
      url: page.url,
      title: page.title,
      name: els.name.value.trim() || page.title,
      html: page.html,
      screenshotDesktopPath: screenshotPaths.desktop || null,
      screenshotMobilePath: screenshotPaths.mobile || null,
      pageType,
      pageTypeLabel,
      category,
      tags,
      projectId: projectId || null,
    };

    const data = await savePage(token, body);

    if (data.projectId) {
      await chrome.storage.local.set({ wasabi_last_project: data.projectId }).catch(() => {});
    }
    const previewUrl = TOOL + data.htmlUrl;
    const editorUrl = TOOL + (data.editorUrl || `/edit/${data.pageId}`);
    const savedWhere = data.projectId ? 'Saved to Competitor Landings ✓' : 'Saved ✓';
    setStatus(
      `${savedWhere} &nbsp;<a href="${editorUrl}" target="_blank">open in editor</a> · ` +
        `<a href="${previewUrl}" target="_blank">view HTML</a>`,
      'ok',
    );
  } catch (e) {
    setStatus(String((e && e.message) || e), 'err');
  } finally {
    if (!funnelPollTimer && !bulkPollTimer) els.save.disabled = false;
  }
}

// Walk a competitor funnel end-to-end: capture + save the current page, then
// ask the background worker to click the forward CTA and wait for the next
// page, repeating until it can't move on. When the click-walk stops (typically
// at the checkout), a discovery pass finds the post-checkout steps (upsell /
// downsell / thank-you) via sitemap + on-page links + platform path guesses,
// and captures those too. Every page is saved as its own project landing,
// grouped under category = domain so they read like one "folder".
const FUNNEL_MAX_STEPS = 14;

function canonUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    ['fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
      'c1', 'c2', 'c3', 'aff_id', 'affiliate_id', 'transaction_id', 'clickid'].forEach((k) => x.searchParams.delete(k));
    const path = (x.pathname || '/').replace(/\/+$/, '') || '/';
    const q = x.searchParams.toString();
    return `${x.origin.toLowerCase()}${path.toLowerCase()}${q ? `?${q}` : ''}`;
  } catch {
    return String(u || '').toLowerCase().replace(/\/+$/, '');
  }
}

async function onSaveFunnel(token, projectId) {
  const startUrl = activeTab.url || '';
  const domain = domainOf(startUrl) || 'funnel';
  const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const visited = [];
  const saved = [];
  // All steps of this walk go into ONE archived_funnels "folder". The first
  // save creates it and returns funnelId; every next save appends to it.
  let funnelId = null;

  // Capture + save whatever page the tab is currently on as the next step.
  const captureCurrentStep = async (index) => {
    const page = await captureHtml(activeTab.id);
    if (visited.some((u) => canonUrl(u) === canonUrl(page.url))) return { skipped: true };
    const screenshotPaths = await captureAndUploadShots(token, activeTab.id, (m) =>
      setStatus(`<span class="spinner"></span>Step ${index}: ${m}`),
    );
    setStatus(`<span class="spinner"></span>Step ${index}: saving…`);
    const data = await savePage(token, {
      url: page.url,
      title: page.title,
      name: `${domain} — Step ${index}`,
      html: page.html,
      screenshotDesktopPath: screenshotPaths.desktop || null,
      screenshotMobilePath: screenshotPaths.mobile || null,
      pageType: 'landing',
      category: domain.slice(0, 60), // domain acts as the funnel "folder"
      tags,
      projectId: projectId || null,
      // Group every step under a single funnel folder.
      funnelGroup: true,
      funnelId: funnelId || undefined,
      funnelName: domain,
      stepIndex: index,
    });
    if (data.funnelId) funnelId = data.funnelId;
    if (data.projectId) {
      await chrome.storage.local.set({ wasabi_last_project: data.projectId }).catch(() => {});
    }
    visited.push(page.url);
    if (data.duplicate) return { skipped: true };
    saved.push({ name: `${domain} — Step ${index}`, pageId: data.pageId });
    return { ok: true };
  };

  // 1) Click-walk: follow the forward CTA page by page.
  for (let i = 1; i <= FUNNEL_MAX_STEPS; i++) {
    setStatus(`<span class="spinner"></span>Step ${i}: reading page…`);
    try {
      await captureCurrentStep(saved.length + 1);
    } catch (e) {
      console.warn('funnel capture stopped:', (e && e.message) || e);
      break;
    }

    setStatus(`<span class="spinner"></span>Step ${saved.length} saved ✓ — looking for next step…`);
    const nav = await sendMessage({ type: 'FUNNEL_NEXT', tabId: activeTab.id, visited });
    if (!nav || !nav.ok || !nav.moved) break; // dead end / checkout / payment host
    try {
      activeTab = await chrome.tabs.get(activeTab.id);
    } catch {
      break;
    }
  }

  // 2) Beyond the checkout: discover the remaining steps and capture them.
  if (saved.length && saved.length < FUNNEL_MAX_STEPS) {
    setStatus('<span class="spinner"></span>Looking beyond the checkout (sitemap / links / paths)…');
    let urls = [];
    try {
      const disc = await sendMessage({ type: 'FUNNEL_DISCOVER', tabId: activeTab.id, visited });
      if (disc && disc.ok && Array.isArray(disc.urls)) urls = disc.urls;
    } catch (e) {
      console.warn('funnel discover failed:', (e && e.message) || e);
    }

    for (const url of urls) {
      if (saved.length >= FUNNEL_MAX_STEPS) break;
      if (visited.some((u) => canonUrl(u) === canonUrl(url))) continue;
      setStatus(`<span class="spinner"></span>Opening discovered step…`);
      const g = await sendMessage({ type: 'FUNNEL_GOTO', tabId: activeTab.id, url });
      if (!g || !g.ok) continue;
      try {
        activeTab = await chrome.tabs.get(activeTab.id);
      } catch {
        break;
      }
      try {
        await captureCurrentStep(saved.length + 1);
      } catch (e) {
        console.warn('discovered step capture failed:', (e && e.message) || e);
      }
    }
  }

  if (!saved.length) {
    setStatus(
      funnelId ? `Funnel already saved (${domain}) — no new pages.` : 'Could not capture any funnel step.',
      funnelId ? 'ok' : 'err',
    );
    return;
  }
  const projLink = projectId
    ? `<a href="${TOOL}/projects/${projectId}" target="_blank">open project</a>`
    : `<a href="${TOOL}" target="_blank">open tool</a>`;
  setStatus(
    `Funnel saved: ${saved.length} step${saved.length > 1 ? 's' : ''} ✓ (${domain}) &nbsp;${projLink}`,
    'ok',
  );
}

// ── Background funnel walk: start + live progress (survives popup close) ──────
let funnelPollTimer = null;

function stopFunnelPoll() {
  if (funnelPollTimer) { clearInterval(funnelPollTimer); funnelPollTimer = null; }
}

async function refreshFunnelStatusOnce() {
  const r = await sendMessage({ type: 'FUNNEL_STATUS' });
  const st = r && r.state;
  if (!st) { stopFunnelPoll(); els.save.disabled = false; return; }
  const count = st.savedCount ? ` (${st.savedCount})` : '';
  // Stalled guard: the background worker can be evicted; if the state hasn't
  // advanced for a while and the worker isn't running, let the user resume.
  if (!st.done && !(r && r.running) && st.updatedAt && Date.now() - st.updatedAt > 45000) {
    stopFunnelPoll();
    els.save.disabled = false;
    setStatus(`Walk interrupted at ${st.savedCount || 0} step(s). Press “Save to Wasabi” to resume.`, 'err');
    return;
  }
  if (st.done) {
    stopFunnelPoll();
    els.save.disabled = false;
    const cls = st.error && !st.savedCount ? 'err' : 'ok';
    const link = st.projectId
      ? ` &nbsp;<a href="${TOOL}/projects/${st.projectId}" target="_blank">open project</a>`
      : ` &nbsp;<a href="${TOOL}" target="_blank">open tool</a>`;
    setStatus(`${st.status || 'Done'}${st.savedCount ? link : ''}`, cls);
    // Return to 0: clear the stored session so reopening shows the idle form.
    await sendMessage({ type: 'FUNNEL_WALK_RESET' });
  } else {
    els.save.disabled = true;
    setStatus(`<span class="spinner"></span>${st.status || 'Walking the funnel…'}${count}`);
  }
}

function startFunnelPoll() {
  stopFunnelPoll();
  els.save.disabled = true;
  refreshFunnelStatusOnce();
  funnelPollTimer = setInterval(refreshFunnelStatusOnce, 1200);
}

async function startBackgroundFunnelWalk(projectId) {
  const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const r = await sendMessage({
    type: 'FUNNEL_WALK_START',
    tabId: activeTab.id,
    projectId: projectId || null,
    tags,
    wantDesktop: els.shotDesktop.checked,
    wantMobile: els.shotMobile.checked,
  });
  if (!r || !r.ok) { setStatus('Could not start the funnel walk.', 'err'); els.save.disabled = false; return; }
  startFunnelPoll();
}

// If a walk is already running (popup was reopened), resume showing progress
// instead of resetting the form. A leftover finished session is cleared → 0.
async function resumeFunnelWalkIfRunning() {
  try {
    const r = await sendMessage({ type: 'FUNNEL_STATUS' });
    const st = r && r.state;
    if (st && st.running && !st.done) {
      if (els.funnelMode) els.funnelMode.checked = true;
      startFunnelPoll();
    } else if (st && st.done) {
      await sendMessage({ type: 'FUNNEL_WALK_RESET' });
    }
  } catch { /* ignore */ }
}

// ── Bulk import (AdSpends lists, pasted URLs) ────────────────────────────────
let bulkPollTimer = null;

const BULK_MAX = 400;

function parseBulkUrlsText(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\s+/)) {
    const raw = line.trim();
    if (!raw) continue;
    let href = raw;
    try {
      const u = new URL(href);
      if (!/^https?:$/i.test(u.protocol)) continue;
      href = u.href;
    } catch {
      continue;
    }
    const key = href.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(href);
    if (out.length >= BULK_MAX) break;
  }
  return out;
}

function updateBulkCount() {
  if (!els.bulkCount) return;
  const n = parseBulkUrlsText(els.bulkUrls && els.bulkUrls.value).length;
  els.bulkCount.textContent = n ? `${n} page${n === 1 ? '' : 's'} ready` : '';
  if (els.bulkMode && els.bulkMode.checked && els.save && !funnelPollTimer && !bulkPollTimer) {
    els.save.textContent = n ? `Save ${n} pages` : 'Save to Wasabi';
  }
}

function syncBulkUi() {
  const on = !!(els.bulkMode && els.bulkMode.checked);
  if (els.bulkBox) els.bulkBox.classList.toggle('hidden', !on);
  if (on && els.funnelMode) els.funnelMode.checked = false;
  if (els.name) {
    const row = els.name.closest && els.name.closest('.field');
    if (row) row.classList.toggle('hidden', on);
  }
  if (!on && els.save && !funnelPollTimer) {
    const toProject = els.destination && els.destination.value === 'project';
    els.save.textContent = toProject ? 'Save to Competitor Landings' : 'Save to Wasabi';
  }
  updateBulkCount();
}

// Harvest landing URLs from the open listing. AdSpends (and similar) only
// put a slice of cards in the DOM — we scroll the grid so more load, and we
// also read the domain/path text under each card (often not a real <a href>).
async function collectListingUrlsInPage() {
  const MAX = 400;
  const SKIP = /adspends|facebook\.com|fb\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|linkedin\.com|pinterest\.com|google\.|doubleclick|googletagmanager|gstatic\.com|cloudflare|jsdelivr|unpkg\.com|stripe\.com|paypal\.com|whatsapp|telegram|gravatar|chrome-extension|sentry\.io|segment\.com|hotjar|intercom/i;
  const unwrap = (href) => {
    try {
      const u = new URL(href, location.href);
      for (const k of ['url', 'u', 'target', 'redirect', 'dest', 'landing', 'href', 'src']) {
        const v = u.searchParams.get(k);
        if (v && /^https?:\/\//i.test(v)) return v;
      }
      return u.href;
    } catch {
      return '';
    }
  };
  const here = (location.hostname || '').replace(/^www\./, '').toLowerCase();
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    let href = String(raw || '').trim();
    if (!href) return;
    if (!/^https?:\/\//i.test(href) && /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\//i.test(href)) {
      href = 'https://' + href;
    }
    href = unwrap(href);
    if (!/^https?:\/\//i.test(href)) return;
    let host = '';
    let path = '';
    try {
      const u = new URL(href);
      host = u.hostname.replace(/^www\./, '').toLowerCase();
      path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    } catch { return; }
    if (!host || host === here || SKIP.test(host) || SKIP.test(href)) return;
    if (path === '/') return;
    if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|pdf|css|js)(\?|$)/i.test(href)) return;
    const key = (host + path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(href);
  };

  const harvest = () => {
    document.querySelectorAll('a[href], iframe[src], [data-url], [data-href], [data-landing], [data-landing-url]').forEach((el) => {
      add(el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-landing') || el.getAttribute('data-landing-url'));
    });
    const text = (document.body && document.body.innerText) || '';
    const re = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>]*)/gi;
    let m;
    while ((m = re.exec(text))) add(m[0].replace(/[).,;:]+$/, ''));
  };

  const scrollables = Array.from(document.querySelectorAll('div, main, section'))
    .filter((el) => {
      const s = getComputedStyle(el);
      const oy = s.overflowY;
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 180;
    })
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const scroller = scrollables[0] || document.scrollingElement || document.documentElement;

  harvest();
  let stagnant = 0;
  for (let i = 0; i < 70 && found.length < MAX; i++) {
    const before = found.length;
    const top = scroller.scrollTop;
    scroller.scrollTop = Math.min(scroller.scrollHeight, top + Math.max(scroller.clientHeight * 0.9, 700));
    await new Promise((r) => setTimeout(r, 500));
    harvest();
    if (found.length === before && scroller.scrollTop <= top + 4) {
      stagnant += 1;
      if (stagnant >= 4) break;
    } else {
      stagnant = 0;
    }
  }
  try { scroller.scrollTop = 0; } catch { /* ignore */ }
  return found.slice(0, MAX);
}

async function scanListingUrls() {
  if (!activeTab || !activeTab.id) {
    setStatus('Open the AdSpends list (or any page with landing links) first.', 'err');
    return;
  }
  setStatus('<span class="spinner"></span>Scanning list — scrolling to load more cards…');
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: collectListingUrlsInPage,
    });
    const urls = (results && results[0] && results[0].result) || [];
    if (!urls.length) {
      setStatus('No landing URLs found on this page. Paste them below, one per line.', 'err');
      return;
    }
    const existing = parseBulkUrlsText(els.bulkUrls.value);
    const merged = parseBulkUrlsText([...existing, ...urls].join('\n'));
    els.bulkUrls.value = merged.join('\n');
    updateBulkCount();
    const known = new Set(knownSavedUrls.map(pageIdentity).filter(Boolean));
    const already = merged.filter((u) => known.has(pageIdentity(u))).length;
    const fresh = merged.length - already;
    setStatus(
      already
        ? `Loaded ${merged.length} from this list (max ${BULK_MAX}/run) · ${already} already saved · ${fresh} new. Not the whole AdSpends DB — only cards Scan can scroll to.`
        : `Loaded ${merged.length} landing URL${merged.length === 1 ? '' : 's'} from the cards on this list (max ${BULK_MAX} per run). Not the whole AdSpends catalog.`,
      'ok',
    );
  } catch (e) {
    setStatus(String((e && e.message) || e), 'err');
  }
}

function stopBulkPoll() {
  if (bulkPollTimer) { clearInterval(bulkPollTimer); bulkPollTimer = null; }
}

function bulkProgressLine(st) {
  const total = Number(st.total) || (st.urls || []).length || 0;
  const saved = Number(st.savedCount) || 0;
  const skipped = Number(st.skippedCount) || 0;
  const failed = Number(st.failedCount) || 0;
  const left = Math.max(0, total - (Number(st.index) || 0));
  return `${saved} saved · ${skipped} already in archive · ${failed} failed · ${left} left`;
}

async function refreshBulkStatusOnce() {
  const r = await sendMessage({ type: 'BULK_STATUS' });
  const st = r && r.state;
  if (els.bulkResume) els.bulkResume.classList.add('hidden');
  if (!st) {
    stopBulkPoll();
    if (els.save) els.save.disabled = false;
    syncBulkUi();
    return;
  }
  const inProgress = !st.done && (st.running || r.running);
  if (inProgress) {
    if (els.save) {
      els.save.disabled = true;
      els.save.textContent = 'Importing…';
    }
    setStatus(`<span class="spinner"></span>${st.status || 'Importing…'}<br>${bulkProgressLine(st)}`);
    return;
  }
  if (!st.done && st.urls && st.urls.length && (Number(st.index) || 0) < st.urls.length) {
    stopBulkPoll();
    if (els.save) els.save.disabled = false;
    if (els.bulkResume) els.bulkResume.classList.remove('hidden');
    setStatus(`${st.status || `Interrupted at ${st.savedCount || 0}/${st.total || '?'}.`} ${bulkProgressLine(st)}`, 'err');
    syncBulkUi();
    return;
  }
  if (st.done) {
    stopBulkPoll();
    if (els.save) els.save.disabled = false;
    const cls = st.error && !st.savedCount ? 'err' : 'ok';
    const link = st.projectId
      ? ` &nbsp;<a href="${TOOL}/projects/${st.projectId}" target="_blank">open project</a>`
      : ` &nbsp;<a href="${TOOL}" target="_blank">open archive</a>`;
    setStatus(`${st.status || 'Done'} · ${bulkProgressLine(st)}${st.savedCount ? link : ''}`, cls);
    await sendMessage({ type: 'BULK_RESET' });
    syncBulkUi();
  } else {
    if (els.save) {
      els.save.disabled = true;
      els.save.textContent = 'Importing…';
    }
    setStatus(`<span class="spinner"></span>${st.status || 'Importing…'}`);
  }
}

function startBulkPoll() {
  stopBulkPoll();
  if (els.save) els.save.disabled = true;
  refreshBulkStatusOnce();
  bulkPollTimer = setInterval(refreshBulkStatusOnce, 1200);
}

async function startBackgroundBulk(projectId) {
  const urls = parseBulkUrlsText(els.bulkUrls && els.bulkUrls.value);
  if (!urls.length) {
    setStatus('Scan the list or paste URLs first.', 'err');
    return;
  }
  const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const category = (els.newCategory.value.trim() || els.category.value || '').slice(0, 60);
  const { pageType, pageTypeLabel } = resolveSavePageType();
  setStatus(`<span class="spinner"></span>Starting ${urls.length} pages… keep the importer window open until it says Done.`);
  if (els.save) {
    els.save.disabled = true;
    els.save.textContent = 'Importing…';
  }
  const r = await sendMessage({
    type: 'BULK_START',
    urls,
    pageType,
    pageTypeLabel,
    category,
    tags,
    projectId: projectId || null,
    savedUrls: knownSavedUrls,
    wantDesktop: els.shotDesktop.checked,
    wantMobile: els.shotMobile.checked,
  });
  if (!r || !r.ok) {
    setStatus((r && r.error) || 'Could not start bulk import.', 'err');
    if (els.save) els.save.disabled = false;
    syncBulkUi();
    return;
  }
  startBulkPoll();
}

async function resumeBulkIfRunning() {
  try {
    const r = await sendMessage({ type: 'BULK_STATUS' });
    const st = r && r.state;
    if (!st) return;
    if (st.done) {
      await sendMessage({ type: 'BULK_RESET' });
      return;
    }
    if (st.running || r.running) {
      if (els.bulkMode) els.bulkMode.checked = true;
      syncBulkUi();
      startBulkPoll();
      return;
    }
    if (st.urls && st.urls.length && (Number(st.index) || 0) < st.urls.length) {
      if (els.bulkMode) els.bulkMode.checked = true;
      syncBulkUi();
      if (els.bulkResume) els.bulkResume.classList.remove('hidden');
      setStatus(`${st.status || 'Import paused.'} ${bulkProgressLine(st)}`, 'err');
    }
  } catch { /* ignore */ }
}

async function resumeBackgroundBulk() {
  if (els.bulkMode) els.bulkMode.checked = true;
  syncBulkUi();
  if (els.save) {
    els.save.disabled = true;
    els.save.textContent = 'Importing…';
  }
  const r = await sendMessage({ type: 'BULK_RESUME' });
  if (!r || !r.ok) {
    setStatus((r && r.error) || 'Could not resume bulk import.', 'err');
    if (els.save) els.save.disabled = false;
    return;
  }
  startBulkPoll();
}

els.save.addEventListener('click', onSave);
els.openTool.addEventListener('click', () => chrome.tabs.create({ url: TOOL }));
if (els.bulkMode) {
  els.bulkMode.addEventListener('change', () => {
    if (els.bulkMode.checked && els.funnelMode) els.funnelMode.checked = false;
    syncBulkUi();
  });
}
if (els.funnelMode) {
  els.funnelMode.addEventListener('change', () => {
    if (els.funnelMode.checked && els.bulkMode) {
      els.bulkMode.checked = false;
      syncBulkUi();
    }
  });
}
if (els.bulkScan) els.bulkScan.addEventListener('click', (e) => { e.preventDefault(); scanListingUrls(); });
if (els.bulkResume) els.bulkResume.addEventListener('click', (e) => { e.preventDefault(); resumeBackgroundBulk(); });
if (els.bulkUrls) els.bulkUrls.addEventListener('input', updateBulkCount);
if (els.addTypeBtn) {
  els.addTypeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!els.newType) return;
    if (els.newType.classList.contains('hidden')) {
      showNewTypeInput();
      return;
    }
    if (els.newType.value.trim()) commitNewType();
    else els.newType.focus();
  });
}
if (els.newType) {
  els.newType.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNewType();
    }
    if (e.key === 'Escape') {
      els.newType.value = '';
      els.newType.classList.add('hidden');
    }
  });
}
document.addEventListener('DOMContentLoaded', init);
init();
