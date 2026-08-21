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

// Download a (usually hotlink-protected, streamed) video from the background.
// Host permissions bypass CORS and `credentials:'include'` reuses the page's
// cookies; a temporary declarativeNetRequest rule injects the Referer/Origin
// (fetch forbids setting those headers directly) that CDNs like TikTok require.
const DNR_REFERER_RULE_ID = 8931;
async function downloadWithReferer(url, pageUrl) {
  let host = '';
  let referer = '';
  let origin = '';
  try {
    const u = new URL(url);
    host = u.hostname;
  } catch {
    return null;
  }
  try {
    if (pageUrl) {
      const p = new URL(pageUrl);
      origin = p.origin;
      referer = p.origin + '/';
    }
  } catch { /* ignore */ }

  const canDNR =
    typeof chrome !== 'undefined' &&
    chrome.declarativeNetRequest &&
    typeof chrome.declarativeNetRequest.updateSessionRules === 'function';

  if (canDNR && referer) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [DNR_REFERER_RULE_ID],
        addRules: [
          {
            id: DNR_REFERER_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                { header: 'referer', operation: 'set', value: referer },
                { header: 'origin', operation: 'set', value: origin || referer },
              ],
            },
            condition: {
              requestDomains: [host],
              resourceTypes: ['xmlhttprequest', 'media', 'other', 'sub_frame', 'image'],
            },
          },
        ],
      });
    } catch { /* best effort */ }
  }

  try {
    const resp = await fetch(url, { credentials: 'include', redirect: 'follow', headers: { Accept: '*/*' } });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return blob && blob.size ? blob : null;
  } catch {
    return null;
  } finally {
    if (canDNR) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_REFERER_RULE_ID] });
      } catch { /* ignore */ }
    }
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
// Funnel walk — advance the tab to the next funnel step by clicking the most
// likely forward CTA, then wait for the navigation to settle. Runs in the
// background so it survives across page loads and can drive chrome.tabs.
// ---------------------------------------------------------------------------

// Canonical URL (origin + path, no hash/trailing slash) for loop detection.
function canonUrl(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/$/, '');
  } catch {
    return String(u || '');
  }
}

// Hosts where we stop BEFORE navigating (external payment/social — a competitor
// funnel can't be walked past its checkout without actually paying).
function isStopHost(u) {
  try {
    const h = new URL(u).hostname;
    return /(^|\.)(paypal\.com|stripe\.com|checkout\.stripe\.com|braintreegateway\.com|facebook\.com|instagram\.com|google\.com|youtube\.com|apple\.com|shopifypay|shop\.app)$/i.test(h);
  } catch {
    return false;
  }
}

// Injected into the page: fill visible, empty form fields with plausible test
// data so required-field validation (ZIP, email, name, consent…) passes and the
// funnel can advance. Uses the native value setter + input/change/blur events so
// React/Vue-controlled inputs register the value. Returns how many it filled.
function fillFunnelForms() {
  const setVal = (el, val) => {
    const proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    } catch { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  const visible = (el) => {
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };
  const ctx = (el) => {
    let t = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('autocomplete') || ''}`;
    const lab = el.labels && el.labels[0];
    if (lab) t += ' ' + (lab.textContent || '');
    return t.toLowerCase();
  };
  let filled = 0;
  const radioSeen = {};
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!visible(el) || el.disabled || el.readOnly) return;
    const type = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'file', 'image', 'search'].includes(type)) return;

    if (el.tagName === 'SELECT') {
      if (!el.value || el.selectedIndex <= 0) {
        const opt = Array.from(el.options).find((o) => o.value && !o.disabled);
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); filled++; }
      }
      return;
    }
    if (type === 'checkbox') {
      if (!el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); filled++; }
      return;
    }
    if (type === 'radio') {
      const n = el.name || String(Math.random());
      if (!radioSeen[n]) { radioSeen[n] = true; if (!el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); filled++; } }
      return;
    }
    if (el.value && el.value.trim()) return; // leave pre-filled values alone

    const c = ctx(el);
    let val = 'John';
    if (type === 'email' || /e-?mail/.test(c)) val = 'test' + Math.floor(100 + Math.random() * 899) + '@gmail.com';
    else if (type === 'tel' || /phone|tel\b|mobile|cell|telefono|whatsapp/.test(c)) val = '2025550' + Math.floor(100 + Math.random() * 899);
    else if (/zip|postal|postcode|\bcap\b/.test(c)) val = '10001';
    else if (/first ?name|given|\bnome\b/.test(c)) val = 'John';
    else if (/last ?name|surname|family|cognome/.test(c)) val = 'Smith';
    else if (/full ?name|your name|\bname\b|nominativo/.test(c)) val = 'John Smith';
    else if (/city|citt/.test(c)) val = 'New York';
    else if (/address|indirizzo|street|via\b/.test(c)) val = '123 Main St';
    else if (/state|provincia|region/.test(c)) val = 'NY';
    else if (type === 'date') val = '1990-01-01';
    else if (type === 'number') val = /age|et[aà]/.test(c) ? '30' : /qty|quantit/.test(c) ? '1' : '10001';
    setVal(el, val);
    filled++;
  });
  return filled;
}

// Injected into the page (runs in the page's context, must be self-contained):
// pick the single most likely "go forward" control. Returns
// { kind:'link', href } | { kind:'click', selector } | null.
function findForwardCta() {
  const CTA = /(continue|next|proceed|checkout|order now|place order|complete|get\s|claim|add to cart|buy now|yes[,! ]|start|begin|apply|check|verify|eligib|qualif|get started|find out|see if|submit|reveal|unlock|avanti|continua|procedi|ordina|acquista|completa|aggiungi al carrello|prosegui|vai al|inizia|verifica|controlla|scopri|richiedi|invia|s[iì][,! ])/i;
  const BAD = /(log ?in|sign ?in|sign ?up|register|menu|home|back|indietro|privacy|terms|termini|cookie|close|chiudi|account|my cart|search|cerca|faq|contact|contatt|support|assist|share|condividi|facebook|instagram|twitter|tiktok|youtube|refund|return|reso)/i;
  const vpH = window.innerHeight || 800;
  const nodes = Array.from(
    document.querySelectorAll('a[href],button,input[type=submit],input[type=button],[role=button],.btn,[class*="btn"],[class*="cta"]'),
  );
  let best = null;
  let bestScore = -1;
  for (const el of nodes) {
    let r;
    try { r = el.getBoundingClientRect(); } catch { continue; }
    if (r.width < 40 || r.height < 18) continue;
    let style;
    try { style = getComputedStyle(el); } catch { continue; }
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const txt = String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 100);
    if (!txt && el.tagName !== 'A') continue;
    if (BAD.test(txt)) continue;
    let score = 0;
    if (CTA.test(txt)) score += 100;
    score += Math.min((r.width * r.height) / 5000, 40);
    if (r.top >= 0 && r.top < vpH) score += 20;
    const href = el.tagName === 'A' ? el.href : '';
    if (href && href.indexOf(location.origin) === 0) score += 10;
    if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /submit|button/.test(el.type))) score += 15;
    if (score > bestScore) { bestScore = score; best = { el, href, txt }; }
  }
  if (!best || bestScore < 40) return null;

  if (best.href && /^https?:/i.test(best.href)) return { kind: 'link', href: best.href, text: best.txt };

  // Build a reasonably-unique selector for the click target.
  const sel = (node) => {
    if (node.id) return '#' + CSS.escape(node.id);
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && parts.length < 6) {
      let p = cur.tagName.toLowerCase();
      const par = cur.parentElement;
      if (par) {
        const same = Array.from(par.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(p);
      cur = par;
    }
    return parts.join('>');
  };
  return { kind: 'click', selector: sel(best.el), text: best.txt };
}

// Wait until the tab finishes loading a URL different from `beforeUrl`.
function waitForNavigation(tabId, beforeUrl, timeoutMs) {
  const beforeCanon = canonUrl(beforeUrl);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(v);
    };
    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      const url = (tab && tab.url) || info.url || '';
      if (!url) return;
      if (canonUrl(url) === beforeCanon) return;
      if (info.status === 'complete' || info.url) {
        // Give SPA/redirect chains a moment to settle before capturing.
        setTimeout(() => finish(true), 900);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs || 15000);
  });
}

async function funnelNext(tabId, visitedArr) {
  const visited = new Set((visitedArr || []).map(canonUrl));
  let before = '';
  try { before = (await chrome.tabs.get(tabId)).url || ''; } catch { return { ok: true, moved: false, reason: 'no-tab' }; }

  // Fill any required form fields first (ZIP, email, name, consent…) so the
  // page's validation lets the CTA advance to the next step.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: fillFunnelForms });
    await sleep(350);
  } catch { /* page may block injection */ }

  let cta = null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: findForwardCta });
    cta = results && results[0] && results[0].result;
  } catch (e) {
    return { ok: true, moved: false, reason: 'inject-failed: ' + (e && e.message) };
  }
  if (!cta) return { ok: true, moved: false, reason: 'no-cta' };

  // Attach the navigation waiter BEFORE triggering the action, otherwise a fast
  // page can fire its 'complete' event before we start listening (false timeout).
  if (cta.kind === 'link' && cta.href) {
    if (isStopHost(cta.href)) return { ok: true, moved: false, reason: 'stop-host' };
    if (visited.has(canonUrl(cta.href))) return { ok: true, moved: false, reason: 'visited' };
    const navPromise = waitForNavigation(tabId, before, 15000);
    try { await chrome.tabs.update(tabId, { url: cta.href }); } catch { return { ok: true, moved: false, reason: 'nav-failed' }; }
    if (!(await navPromise)) return { ok: true, moved: false, reason: 'no-nav' };
  } else if (cta.kind === 'click' && cta.selector) {
    const navPromise = waitForNavigation(tabId, before, 15000);
    let clicked = false;
    try {
      const cr = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
          return false;
        },
        args: [cta.selector],
      });
      clicked = cr && cr[0] && cr[0].result === true;
    } catch { return { ok: true, moved: false, reason: 'click-failed' }; }
    if (!clicked) return { ok: true, moved: false, reason: 'target-gone' };
    if (!(await navPromise)) return { ok: true, moved: false, reason: 'no-nav' };
  } else {
    return { ok: true, moved: false, reason: 'no-target' };
  }

  let after = '';
  try { after = (await chrome.tabs.get(tabId)).url || ''; } catch { return { ok: true, moved: false, reason: 'no-tab-after' }; }
  if (isStopHost(after)) return { ok: true, moved: false, reason: 'stop-host-after', url: after };
  if (visited.has(canonUrl(after))) return { ok: true, moved: false, reason: 'loop', url: after };
  return { ok: true, moved: true, url: after };
}

// ---------------------------------------------------------------------------
// Funnel discovery — after the click-walk stops (e.g. at the checkout), find
// the post-checkout steps (upsell / downsell / thank-you) the way morfeo does:
// the site's sitemap, same-origin links on the page, and platform-specific path
// guesses (Funnelish / CheckoutChamp-Konnektive / WordPress-CartFlows). Every
// candidate is fetched server-side (host permissions bypass CORS) and validated
// before we hand it back for capture.
// ---------------------------------------------------------------------------

// Paths that smell like a funnel step (not blog/legal/nav pages).
const FUNNEL_PATH_RE = /(upsell|up-sell|downsell|down-sell|\boto\b|oto[-_]?\d|one[-_]?time|special[-_]?offer|\boffer\b|order[-_]?bump|\bbump\b|thank[-_ ]?you|thankyou|confirm|confirmation|receipt|success|order[-_]?received|step[-_]?\d|presentation|\bvsl\b|advertorial|checkout|\border\b)/i;

async function fetchText(url) {
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Fetch a candidate page; returns { finalUrl, html } only for real HTML 200s.
async function fetchPage(url) {
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/text\/html/i.test(ct)) return null;
    const html = await r.text();
    return { finalUrl: r.url || url, html };
  } catch {
    return null;
  }
}

function looksLike404(html) {
  const head = String(html || '').slice(0, 2500).toLowerCase();
  return /(404|not found|page not found|pagina non trovata|nothing found|doesn'?t exist)/.test(head) &&
    String(html || '').length < 6000;
}

// Order upsells/OTOs first, downsells next, thank-you/confirmation last.
function scorePath(u) {
  const s = String(u).toLowerCase();
  if (/thank|confirm|receipt|success|order[-_]?received/.test(s)) return 3;
  if (/downsell|down-sell/.test(s)) return 2;
  if (/upsell|up-sell|\boto\b|oto[-_]?\d|offer|special|bump|step/.test(s)) return 1;
  return 2;
}

// Platform-aware path guesses appended to the funnel origin.
function guessPaths(html) {
  const base = [
    '/upsell', '/upsell1', '/upsell-1', '/upsell/1', '/upsell2', '/upsell-2', '/upsell/2',
    '/oto', '/oto1', '/oto-1', '/oto2', '/oto-2',
    '/downsell', '/downsell1', '/downsell-1', '/downsell/1',
    '/offer', '/offer-1', '/special-offer', '/bump',
    '/thank-you', '/thankyou', '/thank_you', '/confirmation', '/order-confirmation',
    '/receipt', '/success', '/step2', '/step3',
  ];
  const h = String(html || '').toLowerCase();
  const extra = [];
  if (/funnelish/.test(h)) extra.push('/upsell/1', '/upsell/2', '/downsell/1', '/downsell/2', '/thank-you');
  if (/checkoutchamp|konnektive|sticky\.io/.test(h)) extra.push('/upsell1', '/upsell2', '/downsell1', '/confirmation', '/step2', '/step3');
  if (/cartflows|woocommerce|woofunnels|wp-content/.test(h)) extra.push('/upsell', '/offer-1', '/thankyou', '/order-received', '/upsell-offer');
  return Array.from(new Set(base.concat(extra)));
}

async function collectSitemapUrls(origin) {
  const out = new Set();
  const queue = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml'];
  const robots = await fetchText(origin + '/robots.txt');
  if (robots) {
    for (const line of robots.match(/^\s*sitemap:\s*(\S+)/gim) || []) {
      const u = line.split(/:\s*/).slice(1).join(':').trim();
      if (u) queue.push(u);
    }
  }
  const seen = new Set();
  let budget = 6; // cap total sitemap fetches
  for (const c of queue) {
    if (budget <= 0) break;
    let u;
    try { u = /^https?:/i.test(c) ? c : origin + c; } catch { continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    budget--;
    const xml = await fetchText(u);
    if (!xml) continue;
    const locs = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs.slice(0, 4)) {
        if (budget <= 0) break;
        budget--;
        const cx = await fetchText(child);
        if (!cx) continue;
        for (const m of cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) out.add(m[1]);
      }
    } else {
      for (const l of locs) out.add(l);
    }
  }
  return Array.from(out);
}

async function funnelDiscover(tabId, visitedArr) {
  const visited = new Set((visitedArr || []).map(canonUrl));
  let curUrl = '';
  try { curUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { return { ok: false, urls: [] }; }
  let origin = '';
  try { origin = new URL(curUrl).origin; } catch { return { ok: false, urls: [] }; }

  // Read the current page for platform detection + same-origin links.
  let html = '';
  let pageLinks = [];
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        html: document.documentElement.outerHTML.slice(0, 200000),
        links: Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).slice(0, 400),
      }),
    });
    const res = r && r[0] && r[0].result;
    if (res) { html = res.html || ''; pageLinks = res.links || []; }
  } catch { /* page may block injection */ }

  // Build the candidate set.
  const cand = new Set();
  for (const p of guessPaths(html)) cand.add(origin + p);
  for (const l of pageLinks) {
    try { if (new URL(l).origin === origin && FUNNEL_PATH_RE.test(l)) cand.add(l); } catch { /* skip */ }
  }
  try {
    for (const l of await collectSitemapUrls(origin)) {
      try { if (new URL(l).origin === origin && FUNNEL_PATH_RE.test(l)) cand.add(l); } catch { /* skip */ }
    }
  } catch { /* sitemap best-effort */ }

  // Validate candidates (real HTML 200, not a soft-404, not a redirect home /
  // to an already-captured page). Cap the number of network checks.
  const valid = [];
  let checks = 0;
  for (const url of cand) {
    if (checks >= 60) break;
    if (visited.has(canonUrl(url))) continue;
    checks++;
    const res = await fetchPage(url);
    if (!res) continue;
    const fu = canonUrl(res.finalUrl);
    if (visited.has(fu)) continue;
    if (fu === canonUrl(origin)) continue; // redirected to home
    if (!res.html || res.html.length < 800) continue;
    if (looksLike404(res.html)) continue;
    valid.push({ url: res.finalUrl, score: scorePath(res.finalUrl) });
    visited.add(fu);
  }
  valid.sort((a, b) => a.score - b.score);
  return { ok: true, urls: valid.map((v) => v.url) };
}

// Navigate the tab to a discovered URL and wait for it to load.
async function funnelGoto(tabId, url) {
  let before = '';
  try { before = (await chrome.tabs.get(tabId)).url || ''; } catch { /* ignore */ }
  const navPromise = waitForNavigation(tabId, before, 20000);
  try { await chrome.tabs.update(tabId, { url }); } catch { return { ok: false }; }
  const ok = await navPromise;
  return { ok };
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

  // Advance the tab to the next funnel step (click the forward CTA + wait for
  // the new page). The popup loops on this to walk the whole funnel.
  if (msg.type === 'FUNNEL_NEXT' && typeof msg.tabId === 'number') {
    funnelNext(msg.tabId, msg.visited || [])
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, moved: false, error: (e && e.message) || String(e) }));
    return true;
  }

  // Discover post-checkout steps (sitemap + on-page links + path guesses).
  if (msg.type === 'FUNNEL_DISCOVER' && typeof msg.tabId === 'number') {
    funnelDiscover(msg.tabId, msg.visited || [])
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, urls: [], error: (e && e.message) || String(e) }));
    return true;
  }

  // Navigate the tab to a discovered URL and wait for load, so the popup can
  // capture it like any other step.
  if (msg.type === 'FUNNEL_GOTO' && typeof msg.tabId === 'number' && msg.url) {
    funnelGoto(msg.tabId, msg.url)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
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

  // Download media straight to the user's computer. http(s) URLs are handed to
  // chrome.downloads (bypasses CORS, reuses cookies for hotlink-protected CDNs);
  // blob:/data: media is downloaded in-page by the content script instead.
  if (msg.type === 'DOWNLOAD_MEDIA') {
    try {
      const url = msg.url || msg.dataUrl;
      if (!url) {
        sendResponse({ ok: false, error: 'nothing to download' });
        return true;
      }
      const opts = { url, saveAs: false };
      if (msg.filename) opts.filename = msg.filename;
      chrome.downloads.download(opts, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          sendResponse({
            ok: false,
            error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed',
          });
        } else {
          sendResponse({ ok: true, id });
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }

  // Sign a direct-to-storage upload for a creative (large videos that can't go
  // inline through the save request). Returns { uploadUrl, path, contentType }.
  if (msg.type === 'SIGN_CREATIVE') {
    toolFetch('/api/extension/sign-creative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: msg.projectId,
        contentType: msg.contentType || 'video/mp4',
        mediaType: msg.mediaType || 'video',
      }),
    }).then((r) => {
      if (r.ok && r.data && r.data.uploadUrl) {
        sendResponse({ ok: true, uploadUrl: r.data.uploadUrl, path: r.data.path, contentType: r.data.contentType });
      } else {
        sendResponse({
          ok: false,
          error: (r.data && (r.data.message || r.data.error)) || `Sign failed (${r.status})`,
        });
      }
    });
    return true;
  }

  // Fetch a (usually cross-origin, streamed) video URL from the background —
  // host_permissions let us read the bytes past CORS — then upload straight to
  // storage via a signed URL and register the creative. This is the path for FB
  // /TikTok/etc. MSE videos the content script can't read in-page.
  if (msg.type === 'FETCH_AND_UPLOAD') {
    (async () => {
      try {
        const blob = await downloadWithReferer(msg.url, msg.pageUrl || '');
        if (!blob) {
          sendResponse({ ok: false, error: 'Could not download this video (the source blocked the request).' });
          return;
        }
        if (blob.size < 10240) {
          sendResponse({ ok: false, error: 'The source returned an invalid/empty video.' });
          return;
        }
        const ct = blob.type || '';
        if (/^text\/html/i.test(ct)) {
          sendResponse({ ok: false, error: 'The source returned a web page instead of the video.' });
          return;
        }
        const contentType = ct || msg.contentType || (msg.isVideo ? 'video/mp4' : 'image/jpeg');

        const sr = await toolFetch('/api/extension/sign-creative', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: msg.projectId,
            contentType,
            mediaType: msg.isVideo ? 'video' : 'image',
          }),
        });
        if (!sr.ok || !sr.data || !sr.data.uploadUrl) {
          sendResponse({ ok: false, error: (sr.data && (sr.data.message || sr.data.error)) || `Sign failed (${sr.status})` });
          return;
        }

        const up = await fetch(sr.data.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
          body: blob,
        });
        if (!up.ok) {
          sendResponse({ ok: false, error: `Upload failed (${up.status})` });
          return;
        }

        const body = {
          projectId: msg.projectId,
          pageUrl: msg.pageUrl,
          pageTitle: msg.pageTitle || '',
          mediaType: msg.isVideo ? 'video' : 'image',
          name: msg.name,
          storagePath: sr.data.path,
          contentType,
        };
        if (msg.brandId) body.brandId = msg.brandId;
        if (msg.brandName) body.brandName = msg.brandName;
        if (msg.autoScrape) {
          body.autoScrape = true;
          body.frequency = msg.frequency;
          body.adsLibraryUrl = msg.adsLibraryUrl;
        }
        const r = await toolFetch('/api/extension/save-creative', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.ok) sendResponse({ ok: true, ...r.data });
        else sendResponse({ ok: false, error: (r.data && (r.data.message || r.data.error)) || `Save failed (${r.status})` });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
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
      if (msg.storagePath) {
        // Bytes already uploaded straight to storage via a signed URL.
        body.storagePath = msg.storagePath;
        if (msg.contentType) body.contentType = msg.contentType;
      } else if (msg.mediaBase64) {
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
