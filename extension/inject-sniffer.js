/* Wasabi Saver — MAIN-world network sniffer.
 *
 * Many sites (Facebook/Instagram Ad Library, but also generic pages) serve
 * videos as `blob:` MSE streams, so the <video> element's src is a blob we
 * can't download and can't ship inline once it's over ~4MB. The real bytes,
 * though, travel over normal fetch/XHR requests to a CDN — as a progressive
 * file (mp4/webm/mov, often split by byte range) or via an HLS/DASH manifest
 * (.m3u8/.mpd). We hook fetch/XHR here — at document_start, before the page's
 * own code runs — record any media URL we see, strip byte-range params to get
 * the full-file URL, tag it progressive vs manifest, and forward it to the
 * (isolated-world) content script via postMessage. The content script prefers
 * a progressive URL (directly downloadable by the server) and only falls back
 * to a manifest when that's all there is.
 *
 * Runs in the MAIN world (no chrome.* APIs); communication is postMessage only.
 */
(function () {
  if (window.__wasabiSniffer) return;
  window.__wasabiSniffer = true;

  // Progressive video files (a single downloadable file). Covers plain
  // extensions, ranged requests (bytestart), YT-style (videoplayback), and
  // TikTok/ByteDance which serve mp4 with no extension (mime_type=video_mp4,
  // /video/tos/, tiktokcdn/tiktokv/muscdn hosts).
  const PROGRESSIVE_RE =
    /\.(mp4|m4v|mov|webm)([?&]|$)|bytestart=|\/video_redirect\/|videoplayback|mime_type=video|\/video\/tos\/|tiktokcdn|tiktokv\.com|muscdn|byteicdn/i;
  // Streaming manifests — need server-side muxing (ffmpeg), not a plain fetch.
  const MANIFEST_RE = /\.m3u8([?&]|$)|\.mpd([?&]|$)/i;
  // Best-effort: skip obvious audio-only tracks.
  const AUDIO_HINT = /\/audio\/|dash_audio|mime_type=audio|[?&]a?itag=(?:139|140|141|249|250|251)\b/i;

  function normalize(u) {
    try {
      const url = new URL(u, location.href);
      // Drop byte-range params so the URL resolves to the WHOLE file.
      url.searchParams.delete('bytestart');
      url.searchParams.delete('byteend');
      url.searchParams.delete('range');
      return url.href;
    } catch {
      return u;
    }
  }

  function report(u) {
    if (!u || typeof u !== 'string') return;
    if (AUDIO_HINT.test(u)) return;
    let kind = '';
    if (PROGRESSIVE_RE.test(u)) kind = 'progressive';
    else if (MANIFEST_RE.test(u)) kind = 'manifest';
    else return;
    try {
      window.postMessage({ __wasabiVideoUrl: normalize(u), kind, t: Date.now() }, '*');
    } catch {
      /* ignore */
    }
  }

  // ── Hook fetch ────────────────────────────────────────────────────────────
  try {
    const _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const u = typeof input === 'string' ? input : input && input.url;
          report(u);
        } catch {
          /* ignore */
        }
        const p = _fetch.apply(this, arguments);
        try {
          if (p && typeof p.then === 'function') {
            p.then(function (resp) { sniffAdResponse(resp, input); }).catch(function () {});
          }
        } catch {
          /* ignore */
        }
        return p;
      };
    }
  } catch {
    /* ignore */
  }

  // ── Hook XMLHttpRequest ───────────────────────────────────────────────────
  try {
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        report(typeof url === 'string' ? url : url && url.toString());
      } catch {
        /* ignore */
      }
      return _open.apply(this, arguments);
    };
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            if (typeof this.responseText === 'string') reportAdJson(this.responseText);
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return _send.apply(this, arguments);
    };
  } catch {
    /* ignore */
  }

  // ── Meta Ad Library copy (primary / title / description / destination) ──
  function parseMaybeJson(text) {
    let s = String(text || '').trim();
    if (s.startsWith('for (;;);')) s = s.slice(9);
    if (s.startsWith('while(1);')) s = s.slice(9);
    try { return JSON.parse(s); } catch { return null; }
  }

  function textOf(v, depth) {
    if (v == null || depth > 4) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const s = textOf(v[i], depth + 1);
        if (s) return s;
      }
      return '';
    }
    if (typeof v === 'object') return textOf(v.text || v.body || v.title || v.value || v.markup, depth + 1);
    return '';
  }

  function pushUrl(list, u) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && list.indexOf(u) === -1) list.push(u);
  }

  function copyFromSnapshot(id, snap) {
    if (!snap || typeof snap !== 'object') return null;
    const imageUrls = [];
    const videoUrls = [];
    const imgs = Array.isArray(snap.images) ? snap.images : [];
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i] || {};
      pushUrl(imageUrls, im.original_image_url || im.resized_image_url);
    }
    const vids = Array.isArray(snap.videos) ? snap.videos : [];
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i] || {};
      pushUrl(videoUrls, v.video_hd_url || v.video_sd_url);
      pushUrl(imageUrls, v.video_preview_image_url);
    }
    const cards = Array.isArray(snap.cards) ? snap.cards : [];
    const card0 = cards[0] || {};
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i] || {};
      pushUrl(imageUrls, c.original_image_url || c.resized_image_url);
      pushUrl(videoUrls, c.video_hd_url || c.video_sd_url);
    }
    const body = textOf(snap.body, 0) || textOf(card0.body, 0);
    const title = textOf(snap.title, 0) || textOf(card0.title, 0);
    const description = textOf(snap.link_description, 0) || textOf(card0.link_description, 0);
    const destination = textOf(snap.link_url, 0) || textOf(card0.link_url, 0) || textOf(snap.caption, 0);
    if (!body && !title && !description && !destination && !imageUrls.length && !videoUrls.length) return null;
    return {
      id: String(id || ''),
      primary: body,
      title,
      description,
      destination,
      imageUrls,
      videoUrls,
    };
  }

  function walkAds(node, out, depth) {
    if (!node || depth > 28 || out.length >= 250) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walkAds(node[i], out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const id = node.adArchiveID || node.ad_archive_id || node.adArchiveId || '';
    let snap = node.snapshot || node.snapshot_v2;
    if (typeof snap === 'string') {
      try { snap = JSON.parse(snap); } catch { snap = null; }
    }
    if (snap && typeof snap === 'object') {
      const copy = copyFromSnapshot(id, snap);
      if (copy) out.push(copy);
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === 'snapshot' || k === 'snapshot_v2') continue;
      const v = node[k];
      if (v && typeof v === 'object') walkAds(v, out, depth + 1);
    }
  }

  function reportAdJson(text) {
    if (!text || text.length < 80 || text.length > 8_000_000) return;
    if (text.indexOf('snapshot') === -1 && text.indexOf('adArchive') === -1 && text.indexOf('ad_archive') === -1) return;
    const data = parseMaybeJson(text);
    if (!data) return;
    const found = [];
    walkAds(data, found, 0);
    for (let i = 0; i < found.length; i++) {
      try { window.postMessage({ __wasabiAdCopy: found[i], t: Date.now() }, '*'); } catch { /* ignore */ }
    }
  }

  function sniffAdResponse(resp, input) {
    try {
      if (!resp || !resp.clone) return;
      const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (!/json|javascript|text\/plain/i.test(ct) && !/graphql|ads\/library/i.test(String(u))) return;
      resp.clone().text().then(function (text) { reportAdJson(text); }).catch(function () {});
    } catch {
      /* ignore */
    }
  }
})();
