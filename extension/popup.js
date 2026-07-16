/* Wasabi Saver — popup logic. */
const CFG = globalThis.WASABI_CONFIG || {};
const TOOL = (CFG.TOOL_ORIGIN || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const els = {
  authState: $('authState'),
  notConnected: $('notConnected'),
  openTool: $('openTool'),
  form: $('form'),
  name: $('name'),
  folder: $('folder'),
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

async function init() {
  if (!TOOL || TOOL.includes('YOUR-TOOL')) {
    els.authState.textContent = 'not configured';
    els.authState.className = 'auth bad';
    setStatus('Edit <code>config.js</code> with your tool + Supabase values, then reload the extension.', 'err');
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

    let screenshots = {};
    if (els.shotDesktop.checked || els.shotMobile.checked) {
      setStatus('<span class="spinner"></span>Taking screenshots…');
      const shots = await sendMessage({ type: 'CAPTURE_SHOTS', tabId: activeTab.id });
      if (shots && shots.ok) {
        if (els.shotDesktop.checked && shots.desktop) screenshots.desktop = shots.desktop;
        if (els.shotMobile.checked && shots.mobile) screenshots.mobile = shots.mobile;
      } else {
        console.warn('screenshots failed:', shots && shots.error);
      }
    }

    setStatus('<span class="spinner"></span>Saving to archive…');
    const tags = els.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
    const body = {
      url: page.url,
      title: page.title,
      name: els.name.value.trim() || page.title,
      html: page.html,
      screenshots,
      pageType: els.folder.value || 'landing',
      tags,
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

    const previewUrl = TOOL + data.htmlUrl;
    const editorUrl = TOOL + (data.editorUrl || `/edit/${data.pageId}`);
    setStatus(
      `Saved ✓ &nbsp;<a href="${editorUrl}" target="_blank">open in editor</a> · ` +
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
