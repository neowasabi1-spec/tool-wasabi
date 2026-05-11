/**
 * Shared Playwright browser launcher.
 *
 * - On Vercel / AWS Lambda / Netlify Functions
 *     → uses @sparticuz/chromium-min (downloads the headless binary
 *       from a remote tar at runtime, keeps the function bundle small)
 * - Locally (`next dev`, `netlify dev`)
 *     → uses playwright-core with the system Chromium installed by
 *       `npx playwright install`
 *
 * All consumer files should import from here instead of importing
 * playwright directly.
 */
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core';

export type { Browser, Page, BrowserContext };

const IS_SERVERLESS =
  !!process.env.VERCEL ||
  !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
  !!process.env.AWS_EXECUTION_ENV ||
  // Netlify Functions: NETLIFY=true is set both at build time and at
  // runtime inside the function, NETLIFY_LOCAL / NETLIFY_DEV mean we
  // are inside `netlify dev` and should keep using system Chromium.
  (!!process.env.NETLIFY && !process.env.NETLIFY_LOCAL && !process.env.NETLIFY_DEV);

/**
 * Launch flags for local Chromium (Windows / macOS / Linux dev box).
 * Intentionally minimal — `--single-process` and `--no-sandbox` are
 * REQUIRED on AWS Lambda / Netlify Functions but CRASH the browser
 * on Windows (the renderer dies as soon as you try to navigate, with
 * "Target page, context or browser has been closed"). Keep them only
 * in the serverless code path.
 */
const LOCAL_DEFAULT_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/**
 * Remote tar with the @sparticuz/chromium binary. Pinned to v131.0.1
 * to match @sparticuz/chromium-min ^131.0.0 in package.json — the two
 * versions MUST stay aligned or Chromium will refuse to launch with
 * "Failed to launch the browser process" or symbol-mismatch errors.
 *
 * Override at runtime with CHROMIUM_REMOTE_TAR if a future deploy
 * needs a different binary without touching code.
 */
const REMOTE_TAR_URL =
  process.env.CHROMIUM_REMOTE_TAR ||
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

/**
 * Cache for the resolved executable path. The chromium-min package
 * downloads + extracts the tar to /tmp on first call (~50MB, 5-10s).
 * We memoise the resolved path PER CONTAINER so warm invocations skip
 * the network round-trip entirely.
 *
 * The promise (not just the value) is cached so concurrent first-hit
 * launches share the single download in-flight instead of all racing
 * to download the same 50MB tarball.
 */
let _executablePathPromise: Promise<string> | null = null;

async function getServerlessExecutablePath(): Promise<string> {
  if (_executablePathPromise) return _executablePathPromise;
  _executablePathPromise = (async () => {
    const sparticuz = (await import('@sparticuz/chromium-min')).default;
    return sparticuz.executablePath(REMOTE_TAR_URL);
  })();
  try {
    return await _executablePathPromise;
  } catch (err) {
    // Reset on failure so the next request can try again instead of
    // permanently caching a rejected promise.
    _executablePathPromise = null;
    throw err;
  }
}

/**
 * Launch a fresh browser instance.
 * Caller is responsible for closing it when done.
 */
export async function launchBrowser(options?: {
  headless?: boolean;
  args?: string[];
}): Promise<Browser> {
  if (IS_SERVERLESS) {
    const t0 = Date.now();
    console.log(
      `[get-browser] SERVERLESS env detected (NETLIFY=${process.env.NETLIFY ?? 'unset'} VERCEL=${process.env.VERCEL ?? 'unset'} AWS_LAMBDA_FUNCTION_NAME=${process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'unset'}) — resolving @sparticuz/chromium-min…`,
    );
    let sparticuz: { args: string[]; executablePath: (url?: string) => Promise<string> };
    try {
      sparticuz = (await import('@sparticuz/chromium-min')).default as unknown as typeof sparticuz;
    } catch (err) {
      console.error(
        '[get-browser] FATAL: @sparticuz/chromium-min not present in function bundle. Check netlify.toml [functions] external_node_modules and included_files.',
        err,
      );
      throw err;
    }
    let executablePath: string;
    try {
      executablePath = await getServerlessExecutablePath();
    } catch (err) {
      console.error(
        `[get-browser] FATAL: failed to resolve Chromium binary from remote tar (${REMOTE_TAR_URL}). Likely cause: outbound network blocked, /tmp full, or download timed out.`,
        err,
      );
      throw err;
    }
    console.log(
      `[get-browser] Chromium resolved in ${Date.now() - t0}ms (executablePath=${executablePath}) — launching…`,
    );

    try {
      const browser = await chromium.launch({
        args: sparticuz.args,
        executablePath,
        headless: true,
      });
      console.log(`[get-browser] Browser launched in ${Date.now() - t0}ms total`);
      return browser;
    } catch (err) {
      console.error(
        '[get-browser] FATAL: chromium.launch failed in serverless. Common causes: (1) /tmp out of space, (2) sandbox issue (sparticuz.args missing --no-sandbox), (3) memory limit hit (Netlify Functions default 1024MB — Chromium needs ~512MB).',
        err,
      );
      throw err;
    }
  }

  console.log('[get-browser] Launching local Chromium (system playwright-core)');
  return chromium.launch({
    headless: options?.headless ?? true,
    args: options?.args ?? LOCAL_DEFAULT_ARGS,
  });
}

/**
 * Singleton browser — reuses one instance across requests within the
 * same serverless invocation (warm starts). Falls back to launching
 * a new one if the previous instance disconnected.
 */
let _singleton: Browser | null = null;

export async function getSingletonBrowser(): Promise<Browser> {
  if (_singleton && _singleton.isConnected()) return _singleton;
  _singleton = await launchBrowser();
  return _singleton;
}
