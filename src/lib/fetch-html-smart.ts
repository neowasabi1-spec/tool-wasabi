/**
 * Centralised HTML fetcher with SPA-render fallback.
 *
 * Cascade:
 *   1) plain `fetch(url)` with a Chrome-like User-Agent (fast, ~95% of sites)
 *   2) sniff for "SPA shell" (<10KB body, `<div id="root">`, etc.)
 *   3) if SPA → render with Playwright (`@/lib/get-browser`)
 *      - works locally with system Chromium
 *      - works on Netlify / Vercel via `@sparticuz/chromium-min`
 *        (binary downloaded from a remote tar at runtime)
 *   4) if Playwright fails or isn't viable → `rescueViaJina()`
 *      (Jina Reader; defence-in-depth for serverless cold-start failures
 *      and the Supabase Edge Function which can't run Playwright)
 *
 * One single helper consumed by every clone / swipe / audit / analyzer
 * code path so SPA support stays consistent and OpenClaw inherits it
 * automatically (it just calls our /api routes internally).
 */

import { isSpaShell, rescueViaJina } from '@/lib/spa-rescue';

export type FetchHtmlSource =
  /** Plain fetch returned non-SPA HTML — used as-is. */
  | 'fetch'
  /** Plain fetch returned SPA shell + all fallbacks failed. */
  | 'fetch-spa-failed'
  /** SPA detected, Playwright successfully rendered the page. */
  | 'playwright-spa'
  /** SPA detected, Playwright disabled (text-only mode), Jina recovered. */
  | 'jina'
  /** SPA detected, Playwright failed, Jina recovered the page. */
  | 'jina-spa-fallback';

export interface FetchHtmlResult {
  ok: boolean;
  html: string;
  /** Which strategy actually produced the HTML. */
  source: FetchHtmlSource | null;
  /** True when the initial fetch returned a JS-only SPA shell. */
  wasSpa: boolean;
  /** Wall-clock time across all fallbacks. */
  durationMs: number;
  /** Per-strategy diagnostics, useful when things go wrong. */
  attempts: string[];
  /** Final error message when ok=false. */
  error?: string;
}

export interface FetchHtmlOptions {
  /**
   * Detection mode:
   * - `'full'`     → fetch → Playwright → Jina (best fidelity, slower)
   * - `'text-only'`→ fetch → Jina (skips Playwright; for text-only
   *                  analyzers where loading a real browser is overkill)
   *
   * Defaults to `'full'`.
   */
  mode?: 'full' | 'text-only';
  /** Fetch timeout in ms (default 20000). */
  fetchTimeoutMs?: number;
  /** Playwright `page.goto` timeout in ms (default 30000). */
  playwrightTimeoutMs?: number;
  /** Override the User-Agent header on the plain fetch step. */
  userAgent?: string;
  /** Additional Accept header (rarely needed). */
  accept?: string;
  /** Extra threshold under which we treat the body as SPA shell.
   *  Defaults to 15000 — observed shell sizes from Vite/CRA/Next
   *  static-export pages routinely sit in the 10-15KB range due to
   *  inlined preamble scripts. */
  spaSizeThreshold?: number;
  /** Disable the Playwright step even in 'full' mode. Used when the
   *  caller has already rendered the page elsewhere. */
  skipPlaywright?: boolean;
  /** Disable Jina entirely (not recommended). */
  skipJina?: boolean;
  /** Optional AbortSignal merged with internal timeouts. */
  signal?: AbortSignal;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/**
 * Heuristics for "this HTML is a JS-rendered shell, the real content
 * is loaded after hydration". Conservative on purpose: false positives
 * here just trigger Playwright (slower but always correct), false
 * negatives leave the user with an empty page.
 */
export function looksLikeSpaShell(
  html: string,
  sizeThreshold = 15000,
): boolean {
  if (!html) return true;
  const lower = html.toLowerCase();

  // Common framework root markers — any of these alone is a strong signal.
  // We deliberately match only the *empty* `<div id=root></div>` form,
  // not the open `<div id="root">` tag, because the open tag is also
  // present in fully server-rendered React/Next pages and would cause
  // false positives that needlessly trigger Playwright.
  const FRAMEWORK_MARKERS = [
    '<div id="root"></div>',
    "<div id='root'></div>",
    '<div id="app"></div>',
    "<div id='app'></div>",
    '<div id="__next"></div>',  // Next.js static export shell
    '<div id="__nuxt"></div>',  // Nuxt
    '<div id="svelte"></div>',  // SvelteKit
    '<noscript>you need to enable javascript to run this app',
    '<noscript>this website requires javascript',
  ];
  for (const marker of FRAMEWORK_MARKERS) {
    if (lower.includes(marker)) return true;
  }

  // Vite / Rollup signature: when the asset bundler ships the typical
  // `/assets/index-<hash>.{js,css}` and the body has no real content
  // tags, we're looking at a JS-only shell. Combining the two avoids
  // false positives on Vite-built but server-rendered pages (rare but
  // possible).
  if (
    /src=["']\/assets\/index-[A-Za-z0-9_-]+\.(?:js|mjs)["']/.test(lower) &&
    !hasContentTags(lower)
  ) {
    return true;
  }

  // Tiny payload (now 15KB to align with observed shell sizes from
  // Vite/CRA/Next-export) → defer to the visible-text heuristic.
  if (html.length < sizeThreshold && isSpaShell(html)) return true;

  // Larger payload but visible text is genuinely empty → SPA.
  if (html.length >= sizeThreshold && isSpaShell(html)) return true;

  // Last-resort: even with a larger payload, if the body contains
  // ZERO content-bearing tags (no `<p`, no `<h1>...<h6>`, no
  // `<article>`, no `<section>`) the page is almost certainly waiting
  // for client-side hydration. The user-suggested heuristic, fixed:
  // matches `<p>` / `<p ` / `<P>` and the headings family equally.
  if (!hasContentTags(lower)) return true;

  return false;
}

/**
 * Returns true if the HTML contains at least one of the structural
 * content tags a real article/landing page would carry. We check both
 * the bare form (`<p>`, `<h1>`) and the with-attributes form (`<p `,
 * `<h1 `) so single-element pages aren't false-flagged.
 */
function hasContentTags(lowercaseHtml: string): boolean {
  if (/<p[\s>]/.test(lowercaseHtml)) return true;
  if (/<h[1-6][\s>]/.test(lowercaseHtml)) return true;
  if (/<article[\s>]/.test(lowercaseHtml)) return true;
  if (/<section[\s>]/.test(lowercaseHtml)) return true;
  if (/<main[\s>]/.test(lowercaseHtml)) return true;
  return false;
}

/**
 * Smart HTML fetcher. See module-level docstring for the cascade.
 */
export async function fetchHtmlSmart(
  url: string,
  opts: FetchHtmlOptions = {},
): Promise<FetchHtmlResult> {
  const start = Date.now();
  const attempts: string[] = [];
  const mode = opts.mode ?? 'full';
  const sizeThreshold = opts.spaSizeThreshold ?? 15000;

  if (!url || typeof url !== 'string') {
    return {
      ok: false,
      html: '',
      source: null,
      wasSpa: false,
      durationMs: Date.now() - start,
      attempts,
      error: 'URL mancante o non valido.',
    };
  }
  let normalised = url.trim();
  try {
    new URL(normalised);
  } catch {
    return {
      ok: false,
      html: '',
      source: null,
      wasSpa: false,
      durationMs: Date.now() - start,
      attempts,
      error: `URL non valido: ${normalised}`,
    };
  }

  // ── 1. Plain fetch ────────────────────────────────────────────────
  let fetchedHtml = '';
  let fetchOk = false;
  try {
    const res = await fetch(normalised, {
      headers: {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? DEFAULT_ACCEPT,
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: mergeSignals(opts.signal, opts.fetchTimeoutMs ?? 20000),
    });
    if (!res.ok) {
      attempts.push(`fetch: HTTP ${res.status} ${res.statusText}`);
    } else {
      fetchedHtml = await res.text();
      fetchOk = true;
      attempts.push(
        `fetch: OK ${fetchedHtml.length} chars (HTTP ${res.status})`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts.push(`fetch: ${msg}`);
  }

  // If fetch produced non-SPA HTML, we're done.
  const wasSpa = fetchOk ? looksLikeSpaShell(fetchedHtml, sizeThreshold) : true;
  if (fetchOk && !wasSpa) {
    return {
      ok: true,
      html: fetchedHtml,
      source: 'fetch',
      wasSpa: false,
      durationMs: Date.now() - start,
      attempts,
    };
  }

  // ── 2. Playwright (skipped in text-only mode) ──────────────────────
  if (mode === 'full' && !opts.skipPlaywright) {
    const pwHtml = await tryPlaywright(
      normalised,
      opts.playwrightTimeoutMs ?? 30000,
      attempts,
    );
    if (pwHtml && !looksLikeSpaShell(pwHtml, sizeThreshold)) {
      console.log(
        `[fetch-html-smart] ✅ Playwright recovered SPA for ${normalised} (${pwHtml.length} chars, ${Date.now() - start}ms total)`,
      );
      return {
        ok: true,
        html: pwHtml,
        source: 'playwright-spa',
        wasSpa,
        durationMs: Date.now() - start,
        attempts,
      };
    }
  }

  // ── 3. Jina rescue ────────────────────────────────────────────────
  if (!opts.skipJina) {
    try {
      const rescued = await rescueViaJina(normalised);
      if (rescued && rescued.length > 200) {
        attempts.push(`jina: OK ${rescued.length} chars`);
        const jinaSource: FetchHtmlSource =
          mode === 'text-only' || opts.skipPlaywright
            ? 'jina'
            : 'jina-spa-fallback';
        console.log(
          `[fetch-html-smart] ✅ Jina recovered (${jinaSource}) for ${normalised} (${rescued.length} chars, ${Date.now() - start}ms total)`,
        );
        return {
          ok: true,
          html: rescued,
          source: jinaSource,
          wasSpa,
          durationMs: Date.now() - start,
          attempts,
        };
      }
      attempts.push('jina: returned null or too short');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push(`jina: ${msg}`);
    }
  }

  // ── 4. Last resort: return whatever fetch gave us, even if SPA shell.
  if (fetchOk && fetchedHtml.length > 0) {
    console.warn(
      `[fetch-html-smart] ⚠️ SPA detected but ALL fallbacks failed for ${normalised} — returning raw shell. Attempts: ${attempts.join(' | ')}`,
    );
    return {
      ok: true,
      html: fetchedHtml,
      source: 'fetch-spa-failed',
      wasSpa,
      durationMs: Date.now() - start,
      attempts,
      error:
        'SPA detected but tutti i fallback hanno fallito — restituito ' +
        'lo shell HTML grezzo.',
    };
  }

  return {
    ok: false,
    html: '',
    source: null,
    wasSpa,
    durationMs: Date.now() - start,
    attempts,
    error: attempts.join(' | ') || 'Tutti i tentativi sono falliti.',
  };
}

/**
 * Convenience: returns just the HTML string or null. Useful for callers
 * that don't need the diagnostics object (e.g. `fetchFunnelHtml`).
 */
export async function fetchHtmlOrNull(
  url: string,
  opts: FetchHtmlOptions = {},
): Promise<string | null> {
  const res = await fetchHtmlSmart(url, opts);
  return res.ok && res.html.length > 0 ? res.html : null;
}

// ─── Internals ─────────────────────────────────────────────────────────

async function tryPlaywright(
  url: string,
  timeoutMs: number,
  attempts: string[],
): Promise<string | null> {
  // Loud, distinctive log so it's easy to grep Netlify Function logs.
  // Filter the Functions tab by "[SPA-FALLBACK]" to see the whole
  // launch sequence (detect → executablePath → launched → goto → done).
  const t0 = Date.now();
  console.log('[SPA-FALLBACK] Detected SPA, launching Playwright for:', url);

  let browser: Awaited<
    ReturnType<typeof import('@/lib/get-browser').launchBrowser>
  > | null = null;

  try {
    // Step 1: import + launch (this internally resolves executablePath
    // for serverless and downloads the chromium-min binary if needed).
    const { launchBrowser } = await import('@/lib/get-browser');
    const tLaunch = Date.now();
    browser = await launchBrowser();
    console.log(
      `[SPA-FALLBACK] Browser launched in ${Date.now() - tLaunch}ms`,
    );

    // Step 2: context + page setup.
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    const page = await context.newPage();

    try {
      // Step 3: navigation. Try networkidle first (best for SPA), then
      // fall back to 'load' which is more tolerant on noisy sites.
      const tGoto = Date.now();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
        console.log(
          `[SPA-FALLBACK] page.goto(networkidle) OK in ${Date.now() - tGoto}ms`,
        );
      } catch (gotoErr) {
        const m =
          gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
        console.warn(
          `[SPA-FALLBACK] networkidle failed (${m}), retrying with waitUntil=load`,
        );
        await page.goto(url, {
          waitUntil: 'load',
          timeout: Math.max(15000, timeoutMs - 5000),
        });
        console.log(
          `[SPA-FALLBACK] page.goto(load) OK in ${Date.now() - tGoto}ms`,
        );
      }

      // Step 4: hydration grace + capture.
      await page.waitForTimeout(1500);
      const html = await page.content();
      console.log(
        `[SPA-FALLBACK] page.content() captured ${html.length} chars (total Playwright path: ${Date.now() - t0}ms)`,
      );
      attempts.push(`playwright: OK ${html.length} chars`);
      return html;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinct, scary error log so we never fail silently in production.
    // The cascade above will then try Jina before giving up.
    console.error(
      `[SPA-FALLBACK] ❌ ERROR after ${Date.now() - t0}ms: ${msg}`,
    );
    if (err instanceof Error && err.stack) {
      console.error('[SPA-FALLBACK] stack:', err.stack);
    }
    attempts.push(`playwright: ${msg}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Combine the caller's AbortSignal with a timeout signal so whichever
 * fires first wins. Falls back to a manually-managed AbortController on
 * runtimes that lack `AbortSignal.timeout` (none in Node 18+, but we
 * guard anyway since this lib runs on every API route).
 */
function mergeSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  let timeoutSignal: AbortSignal;
  if (typeof AbortSignal.timeout === 'function') {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  } else {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
    timeoutSignal = ctrl.signal;
  }
  if (!external) return timeoutSignal;
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (
      AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }
    ).any([external, timeoutSignal]);
  }
  // Polyfill for Node < 20.3 (and edge runtimes without AbortSignal.any)
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  external.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
