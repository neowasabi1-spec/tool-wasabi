/**
 * Centralised HTML fetcher with SPA-render fallback.
 *
 * Cascade:
 *   1) plain `fetch(url)` with a Chrome-like User-Agent (fast, ~95% of sites)
 *   2) sniff for "SPA shell" (<10KB body, `<div id="root">`, etc.)
 *   3) if SPA → render with Playwright (`@/lib/get-browser`)
 *      - works locally with system Chromium
 *      - works on Netlify / Vercel via `@sparticuz/chromium`
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
  | 'fetch'
  | 'playwright'
  | 'jina'
  | 'jina-fallback';

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
   *  Defaults to 10000 to match the original spec
   *  (`<10KB → likely React/Vue/Next shell`). */
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
  sizeThreshold = 10000,
): boolean {
  if (!html) return true;
  const lower = html.toLowerCase();

  // Common framework root markers — any of these alone is a strong signal.
  const FRAMEWORK_MARKERS = [
    '<div id="root"></div>',
    "<div id='root'></div>",
    '<div id="app"></div>',
    "<div id='app'></div>",
    '<div id="__next"></div>',  // Next.js export
    '<div id="__nuxt"></div>',  // Nuxt
    '<div id="svelte"></div>',  // SvelteKit
    '<noscript>you need to enable javascript to run this app',
    '<noscript>this website requires javascript',
  ];
  for (const marker of FRAMEWORK_MARKERS) {
    if (lower.includes(marker)) return true;
  }

  // Tiny payload + has a root div with no inner text → almost certainly SPA.
  if (html.length < sizeThreshold) {
    // But not all small pages are SPAs: tiny landing pages exist.
    // Defer to the more accurate `isSpaShell` heuristic from spa-rescue.ts
    // which actually strips tags and counts visible text.
    if (isSpaShell(html)) return true;
  }

  // Larger payload — only flag as SPA if visible text is genuinely empty.
  if (html.length >= sizeThreshold && isSpaShell(html)) return true;

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
  const sizeThreshold = opts.spaSizeThreshold ?? 10000;

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
      return {
        ok: true,
        html: pwHtml,
        source: 'playwright',
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
        return {
          ok: true,
          html: rescued,
          source: fetchOk ? 'jina-fallback' : 'jina',
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
    return {
      ok: true,
      html: fetchedHtml,
      source: 'fetch',
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
  let browser: Awaited<
    ReturnType<typeof import('@/lib/get-browser').launchBrowser>
  > | null = null;
  try {
    const { launchBrowser } = await import('@/lib/get-browser');
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    const page = await context.newPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      } catch {
        // networkidle is fragile on noisy analytics sites; fall back to load.
        await page.goto(url, {
          waitUntil: 'load',
          timeout: Math.max(15000, timeoutMs - 5000),
        });
      }
      // Give SPAs a moment to hydrate after the initial paint.
      await page.waitForTimeout(1500);
      const html = await page.content();
      attempts.push(`playwright: OK ${html.length} chars`);
      return html;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
