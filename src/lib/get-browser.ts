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

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
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
    const sparticuz = (await import('@sparticuz/chromium-min')).default;
    const executablePath = await getServerlessExecutablePath();

    return chromium.launch({
      args: sparticuz.args,
      executablePath,
      headless: true,
    });
  }

  return chromium.launch({
    headless: options?.headless ?? true,
    args: options?.args ?? DEFAULT_ARGS,
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
