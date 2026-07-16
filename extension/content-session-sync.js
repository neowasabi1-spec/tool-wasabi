// Runs on every page, but only does anything on the Wasabi tool origin.
// There it reads the `wasabi_session` the app stores in localStorage after
// login and forwards it to the background service worker, which caches it so
// the extension can authenticate its API calls as the logged-in user.
(function () {
  try {
    const cfg = globalThis.WASABI_CONFIG || {};
    const toolOrigin = (cfg.TOOL_ORIGIN || '').replace(/\/$/, '');
    if (!toolOrigin || location.origin !== toolOrigin) return;

    function readSession() {
      try {
        const raw = window.localStorage.getItem('wasabi_session');
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.access_token) return null;
        return {
          access_token: s.access_token,
          refresh_token: s.refresh_token || null,
          user_id: s.user_id || null,
          email: s.email || null,
          expires_at: s.expires_at || null,
        };
      } catch {
        return null;
      }
    }

    function push() {
      const session = readSession();
      if (!session) return;
      try {
        chrome.runtime.sendMessage({ type: 'WASABI_SESSION', session });
      } catch {
        /* background may be asleep; it re-asks on demand */
      }
    }

    // Push now and whenever the session changes in another tab.
    push();
    window.addEventListener('storage', (e) => {
      if (e.key === 'wasabi_session') push();
    });
    // Re-push a couple of times in case login completes just after load.
    setTimeout(push, 1500);
    setTimeout(push, 5000);
  } catch {
    /* never break the host page */
  }
})();
