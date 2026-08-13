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
        return _fetch.apply(this, arguments);
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
  } catch {
    /* ignore */
  }
})();
