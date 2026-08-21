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
  tagsField: $('tagsField'),
  tags: $('tags'),
  tagSuggestions: $('tagSuggestions'),
  shotDesktop: $('shotDesktop'),
  shotMobile: $('shotMobile'),
  funnelMode: $('funnelMode'),
  pageUrl: $('pageUrl'),
  save: $('save'),
  status: $('status'),
};

let activeTab = null;

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));
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
      for (const f of data.folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name;
        if (f.id === 'landing') opt.selected = true;
        els.folder.appendChild(opt);
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

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
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

    // Funnel mode: walk the whole funnel and save every step. Delegated to its
    // own routine (it drives navigation via the background worker).
    if (els.funnelMode.checked) {
      await onSaveFunnel(token, toProject ? projectId : null);
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
    // A freshly typed category wins over the dropdown selection.
    const category = (els.newCategory.value.trim() || els.category.value || '').slice(0, 60);
    const body = {
      url: page.url,
      title: page.title,
      name: els.name.value.trim() || page.title,
      html: page.html,
      screenshotDesktopPath: screenshotPaths.desktop || null,
      screenshotMobilePath: screenshotPaths.mobile || null,
      pageType: els.folder.value || 'landing',
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
    els.save.disabled = false;
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
    return (x.origin + x.pathname).replace(/\/$/, '');
  } catch {
    return String(u || '');
  }
}

async function onSaveFunnel(token, projectId) {
  const startUrl = activeTab.url || '';
  const domain = domainOf(startUrl) || 'funnel';
  const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  const visited = [];
  const saved = [];

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
    });
    if (data.projectId) {
      await chrome.storage.local.set({ wasabi_last_project: data.projectId }).catch(() => {});
    }
    visited.push(page.url);
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
    setStatus('Could not capture any funnel step.', 'err');
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

els.save.addEventListener('click', onSave);
els.openTool.addEventListener('click', () => chrome.tabs.create({ url: TOOL }));
document.addEventListener('DOMContentLoaded', init);
init();
