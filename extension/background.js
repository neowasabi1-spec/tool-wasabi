/* Wasabi Saver — background service worker.
 *
 * Responsibilities:
 *   - cache the user's Wasabi session (pushed by the content script running on
 *     the tool origin, or read on demand by the popup) so API calls run as the
 *     logged-in user
 *   - capture full-page desktop + mobile screenshots of a tab via the Chrome
 *     DevTools Protocol (chrome.debugger)
 */
importScripts('config.js');

// ---------------------------------------------------------------------------
// Session management (no external keys needed — we reuse the tool's session)
// ---------------------------------------------------------------------------
async function getSession() {
  const { wasabi_session } = await chrome.storage.local.get('wasabi_session');
  return wasabi_session || null;
}
async function setSession(s) {
  await chrome.storage.local.set({ wasabi_session: s });
}
async function getToken() {
  const s = await getSession();
  return (s && s.access_token) || null;
}

// Tool origin for authenticated API calls (config.js is imported below).
const TOOL_ORIGIN = ((globalThis.WASABI_CONFIG || {}).TOOL_ORIGIN || '').replace(/\/$/, '');

async function toolFetch(path, init = {}) {
  const token = await getToken();
  if (!token) return { ok: false, status: 401, data: { error: 'not connected' } };
  const headers = Object.assign({}, init.headers, { Authorization: `Bearer ${token}` });
  try {
    const res = await fetch(TOOL_ORIGIN + path, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String((e && e.message) || e) } };
  }
}

// ---------------------------------------------------------------------------
// Screenshots via chrome.debugger (CDP)
// ---------------------------------------------------------------------------
function dbgAttach(tabId) {
  return new Promise((res, rej) =>
    chrome.debugger.attach({ tabId }, '1.3', () =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(),
    ),
  );
}
function dbgDetach(tabId) {
  return new Promise((res) => chrome.debugger.detach({ tabId }, () => res()));
}
function dbgSend(tabId, method, params) {
  return new Promise((res, rej) =>
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r),
    ),
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_INLINE_BYTES = 25 * 1024 * 1024;

// Download media bytes with the extension's host permissions (bypasses CORS
// and reuses the browser's cookies for hotlink-protected CDNs). Returns a
// data URL, or null on failure / oversize so the server can try its own fetch.
async function fetchMediaAsDataUrl(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_INLINE_BYTES) return null;
    const buf = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const type = blob.type || 'application/octet-stream';
    return { dataUrl: `data:${type};base64,${btoa(binary)}`, type };
  } catch {
    return null;
  }
}

const MAX_SHOT_HEIGHT = 18000; // cap absurdly tall pages

async function captureViewport(tabId, { width, height, mobile, dsf }) {
  await dbgSend(tabId, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: dsf,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await sleep(700);
  try {
    await dbgSend(tabId, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, document.body.scrollHeight); void 0;',
    });
    await sleep(400);
    await dbgSend(tabId, 'Runtime.evaluate', { expression: 'window.scrollTo(0, 0); void 0;' });
    await sleep(200);
  } catch {
    /* ignore */
  }

  const metrics = await dbgSend(tabId, 'Page.getLayoutMetrics');
  const cs = (metrics && (metrics.cssContentSize || metrics.contentSize)) || { width, height };
  const shotWidth = Math.ceil(cs.width) || width;
  const shotHeight = Math.min(Math.ceil(cs.height) || height, MAX_SHOT_HEIGHT);

  const { data } = await dbgSend(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 72,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: shotWidth, height: shotHeight, scale: 1 },
  });

  await dbgSend(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
  return 'data:image/jpeg;base64,' + data;
}

async function captureScreenshots(tabId) {
  await dbgAttach(tabId);
  try {
    await dbgSend(tabId, 'Page.enable').catch(() => {});
    let desktop = null;
    let mobile = null;
    try {
      desktop = await captureViewport(tabId, { width: 1280, height: 900, mobile: false, dsf: 1 });
    } catch (e) {
      console.warn('[wasabi] desktop screenshot failed:', e.message);
    }
    try {
      mobile = await captureViewport(tabId, { width: 390, height: 844, mobile: true, dsf: 2 });
    } catch (e) {
      console.warn('[wasabi] mobile screenshot failed:', e.message);
    }
    return { desktop, mobile };
  } finally {
    await dbgDetach(tabId);
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'WASABI_SESSION' && msg.session) {
    setSession(msg.session).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'AUTH_STATE') {
    getSession().then((s) =>
      sendResponse({ connected: !!(s && s.access_token), email: (s && s.email) || null }),
    );
    return true;
  }

  if (msg.type === 'GET_TOKEN') {
    getToken().then((token) => sendResponse({ token }));
    return true;
  }

  if (msg.type === 'CAPTURE_SHOTS' && typeof msg.tabId === 'number') {
    captureScreenshots(msg.tabId)
      .then((shots) => sendResponse({ ok: true, ...shots }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Project list for the in-page creative picker.
  if (msg.type === 'GET_PROJECTS') {
    toolFetch('/api/projecthub/projects').then((r) => {
      if (!r.ok) {
        sendResponse({ ok: false, error: r.data && r.data.error ? r.data.error : 'not connected' });
        return;
      }
      const projects = (Array.isArray(r.data) ? r.data : []).map((p) => ({
        id: p.id,
        name: p.name || 'Untitled',
      }));
      sendResponse({ ok: true, projects });
    });
    return true;
  }

  // Save a single creative into a project's Competitor Library.
  if (msg.type === 'SAVE_CREATIVE') {
    (async () => {
      const body = {
        projectId: msg.projectId,
        pageUrl: msg.pageUrl,
        pageTitle: msg.pageTitle,
        mediaUrl: msg.mediaUrl,
        mediaType: msg.mediaType,
        name: msg.name,
      };
      if (msg.mediaBase64) {
        body.mediaBase64 = msg.mediaBase64;
        if (msg.contentType) body.contentType = msg.contentType;
      } else if (msg.mediaUrl && /^https?:\/\//i.test(msg.mediaUrl)) {
        // Try to grab the bytes ourselves first (works for hotlink-protected
        // CDNs); on failure the server falls back to its own fetch / URL ref.
        const inline = await fetchMediaAsDataUrl(msg.mediaUrl);
        if (inline) {
          body.mediaBase64 = inline.dataUrl;
          body.contentType = inline.type;
        }
      }
      const r = await toolFetch('/api/extension/save-creative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) sendResponse({ ok: true, ...r.data });
      else
        sendResponse({
          ok: false,
          error: (r.data && (r.data.message || r.data.error)) || `Save failed (${r.status})`,
        });
    })();
    return true;
  }

  return false;
});
