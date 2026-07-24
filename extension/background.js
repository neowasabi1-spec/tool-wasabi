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

// Config (config.js is imported at the top of this worker).
const CFG = globalThis.WASABI_CONFIG || {};
const TOOL_ORIGIN = (CFG.TOOL_ORIGIN || '').replace(/\/$/, '');
const SUPABASE_URL = (CFG.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY || '';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Supabase access tokens expire (~1h). Exchange the stored refresh_token for a
// fresh access token via the public refresh_token grant. Returns the new
// access token, or null when we can't refresh (no refresh_token / revoked).
async function refreshSession() {
  const s = await getSession();
  if (!s || !s.refresh_token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.access_token) return null;
    const fresh = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || s.refresh_token,
      user_id: (data.user && data.user.id) || s.user_id || null,
      email: (data.user && data.user.email) || s.email || null,
      expires_at: data.expires_at || (data.expires_in ? nowSec() + data.expires_in : null),
    };
    await setSession(fresh);
    return fresh.access_token;
  } catch {
    return null;
  }
}

// Return a valid (non-expired) access token, refreshing proactively when the
// cached one is within 60s of expiry.
async function getValidToken() {
  const s = await getSession();
  if (!s || !s.access_token) return null;
  let exp = Number(s.expires_at || 0);
  if (exp > 1e12) exp = Math.floor(exp / 1000); // tolerate ms timestamps
  if (exp && exp - 60 <= nowSec()) {
    const refreshed = await refreshSession();
    return refreshed || s.access_token;
  }
  return s.access_token;
}

async function toolFetch(path, init = {}) {
  let token = await getValidToken();
  if (!token) return { ok: false, status: 401, data: { error: 'not connected' } };
  const doFetch = async (tok) => {
    const headers = Object.assign({}, init.headers, { Authorization: `Bearer ${tok}` });
    const res = await fetch(TOOL_ORIGIN + path, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  try {
    let { res, data } = await doFetch(token);
    // Reactive refresh: a 401 despite a cached token means it went stale
    // between the expiry check and the call (or expires_at was missing).
    if (res.status === 401) {
      const refreshed = await refreshSession();
      if (refreshed) ({ res, data } = await doFetch(refreshed));
    }
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

// Kept well under Netlify's ~6MB function request-body limit: base64 inflates
// bytes by ~33%, so 4MB of media -> ~5.3MB body. Larger media is fetched
// server-side from its URL instead of being shipped inline.
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

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
    getValidToken().then((token) => sendResponse({ token }));
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

  // List competitors (brands) already saved in a project.
  if (msg.type === 'GET_COMPETITORS') {
    toolFetch(`/api/projecthub/projects/${msg.projectId}/competitor-library`).then((r) => {
      if (!r.ok) {
        sendResponse({ ok: false, error: r.data && r.data.error ? r.data.error : 'not connected' });
        return;
      }
      const competitors = (Array.isArray(r.data) ? r.data : []).map((c) => ({
        id: c.id,
        name: c.name || 'Competitor',
      }));
      sendResponse({ ok: true, competitors });
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
      if (msg.brandId) body.brandId = msg.brandId;
      if (msg.brandName) body.brandName = msg.brandName;
      if (msg.autoScrape) {
        body.autoScrape = true;
        body.frequency = msg.frequency;
        body.adsLibraryUrl = msg.adsLibraryUrl;
      }
      if (msg.mediaBase64) {
        body.mediaBase64 = msg.mediaBase64;
        if (msg.contentType) body.contentType = msg.contentType;
      } else if (msg.mediaUrl && /^https?:\/\//i.test(msg.mediaUrl)) {
        // Prefer letting the server fetch http(s) media (no request-body limit).
        // Only inline small files client-side (helps hotlink-protected CDNs).
        const inline = await fetchMediaAsDataUrl(msg.mediaUrl);
        if (inline) {
          body.mediaBase64 = inline.dataUrl;
          body.contentType = inline.type;
        }
      }

      // Guard Netlify's ~6MB request-body limit. If inline media is too big,
      // drop it and let the server fetch the URL; if there's no fetchable URL
      // (e.g. a blob: video), tell the user to use auto-scraping instead.
      if (body.mediaBase64 && body.mediaBase64.length > 5_200_000) {
        if (body.mediaUrl && /^https?:\/\//i.test(body.mediaUrl)) {
          delete body.mediaBase64;
          delete body.contentType;
        } else {
          sendResponse({
            ok: false,
            error:
              'This video is too large to save directly. Enable auto-scraping with the Ad Library URL — the server will capture it.',
          });
          return;
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
