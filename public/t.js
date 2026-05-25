/*!
 * Wasabi Tracker (t.js) — v1
 * ---------------------------------------------------------------------------
 * Script di tracking iniettato automaticamente da
 * src/lib/wasabi-tracker-inject.ts in tutte le pagine clonate/riscritte
 * salvate via persistHtmlToStorage (vedi src/lib/funnel-html-storage.ts).
 *
 * Cosa fa:
 *   1. Genera/riusa un session_id (uuid v4) in sessionStorage. Niente
 *      cookie, niente fingerprint. Vive finche' la tab e' aperta.
 *   2. Manda un 'pageview' a /api/track/event al caricamento.
 *   3. Espone window.wsbTrack(eventType, payload) per quiz, CTA, etc.
 *   4. Al cambio di visibilita' (tab close, navigazione) manda 'step_exit'
 *      con dwell_ms (tempo speso sulla pagina).
 *   5. Riscrive automaticamente i link uscenti verso altri host del funnel,
 *      appendendo ?wsid=<session_id> — cosi' la sessione si propaga
 *      cross-host (Replit -> CC, Lovable -> Funnelish, ecc).
 *   6. Auto-tracking dei click su CTA evidenti (<a> e <button> con href
 *      esterno, type=submit, o class contenente 'cta'/'buy'/'order').
 *   7. Skip silenzioso se la pagina e' in iframe (= preview Wasabi), su
 *      localhost, o se navigator.webdriver (bot).
 *
 * Filosofia:
 *   - Single file, no dependencies, no build step. < 4 KB minified.
 *   - Fail-soft ovunque: una sola try/catch al top, niente console errors
 *     in production. Se qualcosa va storto, la pagina dell'utente finale
 *     non si rompe.
 *   - fire-and-forget: navigator.sendBeacon dove disponibile, fetch
 *     keepalive come fallback. Mai blocking.
 *   - Idempotente: se due tag finiscono nella stessa pagina (rara, ma
 *     possibile con re-edit), il secondo no-op.
 */
(function () {
  'use strict';

  // Singleton guard: due tag in pagina = secondo no-op.
  if (window.__wsb_loaded) return;
  window.__wsb_loaded = true;

  // ── Config dal <script> tag ─────────────────────────────────────────────
  // Il tag iniettato e':
  //   <script src=".../t.js?v=1" data-wasabi-tracker="1"
  //           data-funnel="<uuid>" data-page="<uuid>" data-step="..." defer>
  //   </script>
  // document.currentScript funziona durante l'esecuzione iniziale; con
  // defer + DOMContentLoaded gia' triggered, fallback su querySelector.
  var script =
    document.currentScript ||
    document.querySelector('script[data-wasabi-tracker]');
  if (!script) return;

  var FUNNEL_ID = script.getAttribute('data-funnel') || '';
  var PAGE_ID = script.getAttribute('data-page') || '';
  var STEP_TYPE = script.getAttribute('data-step') || '';

  if (!FUNNEL_ID) return;

  // Endpoint: stesso origin del src del tag (cosi' niente env da configurare
  // lato HTML iniettato — il src ha gia' l'host giusto).
  var ENDPOINT;
  try {
    var srcUrl = new URL(script.src, location.href);
    ENDPOINT = srcUrl.origin + '/api/track/event';
  } catch (e) {
    return;
  }

  // ── Skip conditions (debug + preview + bot) ─────────────────────────────
  // In iframe = quasi sicuramente preview dell'editor Wasabi. Non vogliamo
  // inquinare i dati con eventi delle preview.
  if (window.top !== window.self) return;
  // Local dev: niente tracking per le tue prove locali.
  if (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(location.host) ||
    location.protocol === 'file:'
  ) {
    return;
  }
  // navigator.webdriver = true negli automated browsers (Puppeteer/
  // Playwright/Selenium). Non blocchiamo, ma mettiamo is_bot=true cosi' la
  // vista drop-off li esclude.
  var IS_BOT = Boolean(navigator.webdriver);

  // ── Session id ──────────────────────────────────────────────────────────
  // Priorita': ?wsid= in URL (sessione cross-host propagata) > sessionStorage
  // > nuova generata. Salviamo sempre in sessionStorage cosi' i pageview
  // successivi sulla stessa tab usano lo stesso id.
  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) {
      try {
        return window.crypto.randomUUID();
      } catch (e) {
        /* fallthrough */
      }
    }
    // Fallback browser vecchi (< Chrome 92): UUID v4 RFC 4122 manuale.
    var t = (Date.now() + (performance && performance.now ? performance.now() : 0)).toString(16);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) + t.slice(-4);
  }

  function readQueryWsid() {
    try {
      var p = new URLSearchParams(location.search);
      var w = p.get('wsid');
      if (w && /^[a-z0-9-]{8,64}$/i.test(w)) return w;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  var SESSION_KEY = 'wsb_sid';
  var SESSION_ID;
  try {
    SESSION_ID = readQueryWsid();
    if (!SESSION_ID) {
      SESSION_ID = sessionStorage.getItem(SESSION_KEY);
    }
    if (!SESSION_ID) {
      SESSION_ID = uuidv4();
    }
    sessionStorage.setItem(SESSION_KEY, SESSION_ID);
  } catch (e) {
    // sessionStorage bloccato (Safari ITP, modalita' privata strict): fallback
    // su una sola sessione in-memory per questo pageload. Persiste fino a
    // reload, poi si perde — accettabile.
    SESSION_ID = SESSION_ID || uuidv4();
  }

  // ── Send: sendBeacon > fetch keepalive ──────────────────────────────────
  // Content-Type "text/plain" evita il preflight OPTIONS (la POST diventa
  // simple request CORS). Il server parsa il body come JSON manualmente.
  function send(body) {
    var payload;
    try {
      payload = JSON.stringify(body);
    } catch (e) {
      return;
    }
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'text/plain' });
        navigator.sendBeacon(ENDPOINT, blob);
        return;
      }
    } catch (e) {
      /* fallthrough to fetch */
    }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: payload,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
      }).catch(function () {
        /* fire and forget */
      });
    } catch (e) {
      /* nothing else to try */
    }
  }

  function track(eventType, extraPayload) {
    send({
      funnel_id: FUNNEL_ID,
      page_id: PAGE_ID || null,
      session_id: SESSION_ID,
      event_type: eventType,
      url: location.href,
      referrer: document.referrer,
      payload: extraPayload || {},
      is_bot: IS_BOT,
    });
  }

  // Esponi l'API per quiz, CTA custom, eventi di terze parti, ecc.
  // Idempotente: se gia' definita (improbabile, ma...), non sovrascrive.
  if (!window.wsbTrack) {
    window.wsbTrack = track;
  }

  // ── Pageview iniziale ───────────────────────────────────────────────────
  var PAGE_LOAD_TS = Date.now();
  track('pageview');

  // ── Cross-host link rewriting (?wsid propagation) ───────────────────────
  // Per ogni <a href> che punta a un altro host, appendi ?wsid=<sid>.
  // Cosi' la sessione sopravvive al cambio di dominio (Replit -> CC, ecc.).
  // Limit: solo gli host del funnel — non vogliamo propagare il sid a
  // google.com / facebook.com etc. In v1 facciamo "tutti gli host diversi":
  // se serve restringere, leggi data-domains dal tag.
  // Idempotente: se l'URL ha gia' wsid, non lo sovrascriviamo.
  function rewriteOutboundLinks() {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(href)) continue;
      try {
        var u = new URL(href, location.href);
        if (u.host === location.host) continue;
        // Skip social/known-external — semplice deny list.
        if (
          /\b(google|facebook|instagram|twitter|x|youtube|linkedin|tiktok|pinterest|reddit)\.(com|net|org)\b/i.test(
            u.host,
          )
        ) {
          continue;
        }
        if (!u.searchParams.has('wsid')) {
          u.searchParams.set('wsid', SESSION_ID);
          a.setAttribute('href', u.toString());
        }
      } catch (e) {
        /* invalid URL, skip */
      }
    }
  }

  // L'inject e' via </head> con defer, il DOM e' parsato — eseguibile subito.
  // Per i link aggiunti dinamicamente (SPA, ad-injected, lazy), ri-eseguiamo
  // su DOMContentLoaded e dopo 1.5s (cattura iniezioni async tipiche).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteOutboundLinks);
  } else {
    rewriteOutboundLinks();
  }
  setTimeout(rewriteOutboundLinks, 1500);

  // ── CTA auto-tracking ───────────────────────────────────────────────────
  // Captures click on:
  //   - <a> con href esterno (probabile next-step del funnel)
  //   - <button type="submit"> (form, di solito = checkout/quiz next)
  //   - elementi con class contenente cta/buy/order/checkout/buynow
  // Per evitare doppi conteggi, usiamo capture phase + dedup per click event.
  document.addEventListener(
    'click',
    function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      // Cerca anchor/button risalendo (in caso di click su uno span dentro).
      var el = t.closest && t.closest('a, button, [role="button"]');
      if (!el) return;

      var isAnchor = el.tagName === 'A';
      var isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      var cls = ((el.className && el.className.toString) ? el.className.toString() : '').toLowerCase();
      var isCtaClass = /(cta|buy|order|checkout|buy-now|add-to-cart|submit)/i.test(cls);

      var payload = {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        href: isAnchor ? el.getAttribute('href') : null,
        id: el.id || null,
        cls: cls.slice(0, 120) || null,
      };

      if (isCtaClass) {
        track('cta_click', payload);
        return;
      }
      if (isAnchor && payload.href && !/^#/.test(payload.href)) {
        // Solo link "navigazionali" (non hash interno).
        track('cta_click', payload);
        return;
      }
      if (isButton && el.getAttribute('type') === 'submit') {
        track('cta_click', payload);
        return;
      }
    },
    true,
  );

  // ── Form submit tracking ────────────────────────────────────────────────
  document.addEventListener(
    'submit',
    function (ev) {
      var f = ev.target;
      if (!f || f.tagName !== 'FORM') return;
      track('form_submit', {
        action: f.getAttribute('action') || null,
        id: f.id || null,
        name: f.getAttribute('name') || null,
      });
    },
    true,
  );

  // ── Step exit (dwell_ms) ────────────────────────────────────────────────
  // pagehide e' piu' affidabile di beforeunload per bfcache + iOS Safari.
  // visibilitychange con state=hidden cattura il tab-switch (utile per
  // capire dwell reale anche senza navigazione).
  var EXIT_SENT = false;
  function sendExit(reason) {
    if (EXIT_SENT) return;
    EXIT_SENT = true;
    track('step_exit', {
      dwell_ms: Date.now() - PAGE_LOAD_TS,
      reason: reason || 'unload',
    });
  }
  window.addEventListener('pagehide', function () {
    sendExit('pagehide');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      sendExit('hidden');
    } else if (document.visibilityState === 'visible' && EXIT_SENT) {
      // L'utente e' tornato sulla tab — riarmiamo per il prossimo exit, ma
      // NON contiamo come nuovo pageview (sarebbe doppio).
      EXIT_SENT = false;
      PAGE_LOAD_TS = Date.now();
    }
  });

  // Step entered (utile per SPA dove il pageview iniziale non corrisponde
  // allo step effettivo). Per ora coincide col pageview iniziale; in futuro
  // se aggiungiamo SPA navigation tracking, qui si chiama anche su
  // pushState/replaceState.
  track('step_enter', { step: STEP_TYPE || null });
})();
