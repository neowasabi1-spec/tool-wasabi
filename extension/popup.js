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

async function onSave() {
  els.save.disabled = true;
  try {
    const token = (await sendMessage({ type: 'GET_TOKEN' }))?.token;
    if (!token) {
      setStatus('Session expired. Open the tool, log in, and reopen this popup.', 'err');
      els.notConnected.classList.remove('hidden');
      return;
    }

    setStatus('<span class="spinner"></span>Reading page…');
    const page = await captureHtml(activeTab.id);

    // Capture screenshots, then upload them STRAIGHT to storage via signed URLs.
    // Full-page PNGs are megabytes each; sending them inline in the save JSON
    // blew past the 6MB serverless body limit and failed the whole save with a
    // 413. Now only their storage paths travel in the save request.
    const screenshotPaths = {};
    if (els.shotDesktop.checked || els.shotMobile.checked) {
      setStatus('<span class="spinner"></span>Taking screenshots…');
      const shots = await sendMessage({ type: 'CAPTURE_SHOTS', tabId: activeTab.id });
      if (shots && shots.ok) {
        const pending = [];
        if (els.shotDesktop.checked && shots.desktop) pending.push(['desktop', shots.desktop]);
        if (els.shotMobile.checked && shots.mobile) pending.push(['mobile', shots.mobile]);
        if (pending.length) {
          setStatus('<span class="spinner"></span>Uploading screenshots…');
          for (const [variant, dataUrl] of pending) {
            try {
              screenshotPaths[variant] = await uploadShot(token, variant, dataUrl);
            } catch (e) {
              // Screenshots are best-effort: don't fail the save over them, and
              // don't fall back to inline base64 (that's what caused the 413).
              console.warn(`screenshot ${variant} upload failed:`, (e && e.message) || e);
            }
          }
        }
      } else {
        console.warn('screenshots failed:', shots && shots.error);
      }
    }

    const toProject = els.destination.value === 'project';
    const projectId = toProject ? (els.project.value || '') : '';
    if (toProject && !projectId) {
      setStatus('Select a project first.', 'err');
      return;
    }
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

    const res = await fetch(`${TOOL}/api/extension/save-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || `Save failed (${res.status})`);
    }

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

els.save.addEventListener('click', onSave);
els.openTool.addEventListener('click', () => chrome.tabs.create({ url: TOOL }));
document.addEventListener('DOMContentLoaded', init);
init();
