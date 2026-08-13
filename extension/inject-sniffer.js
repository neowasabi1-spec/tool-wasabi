/* Wasabi Saver — MAIN-world network sniffer.
 *
 * Facebook/Instagram serve Ad Library videos as `blob:` MSE streams, so the
 * <video> element's src is a blob we can't download and can't ship inline once
 * it's bigger than ~4MB. The real bytes, however, come from fbcdn over normal
 * fetch/XHR requests (progressive MP4, split by byte range). We hook fetch/XHR
 * here — at document_start, before the page's own code runs — record any
 * video-CDN URL we see, strip the byte-range params to get the full-file URL,
 * and forward it to the (isolated-world) content script via postMessage. The
 * content script can then send that URL to the server, which downloads the
 * complete video with no blob/size limit.
 *
 * Runs in the MAIN world (no chrome.* APIs); communication is postMessage only.
 */
(function () {
  if (window.__wasabiSniffer) return;
  window.__wasabiSniffer = true;

  // Matches fbcdn video segments / progressive mp4 / dash video URLs. `bytestart`
  // is the strongest signal for a ranged video-file request.
  const VIDEO_RE = /\.mp4([?&]|$)|bytestart=|\/video_redirect\/|fbcdn\.net\/v\//i;
  // Best-effort: skip obvious audio-only DASH tracks.
  const AUDIO_HINT = /[?&](?:_nc_)?.*audio|\/audio\/|dash_audio|mime_type=audio/i;

  function normalize(u) {
    try {
      const url = new URL(u, location.href);
      // Drop byte-range params so the URL resolves to the WHOLE file.
      url.searchParams.delete('bytestart');
      url.searchParams.delete('byteend');
      return url.href;
    } catch {
      return u;
    }
  }

  function report(u) {
    if (!u || typeof u !== 'string') return;
    if (!VIDEO_RE.test(u)) return;
    if (AUDIO_HINT.test(u)) return;
    try {
      window.postMessage({ __wasabiVideoUrl: normalize(u), t: Date.now() }, '*');
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
