/**
 * Shared Playwright browser launcher.
 *
 * - On Vercel / AWS Lambda  → uses @sparticuz/chromium (minimal headless binary)
 * - Locally (dev)           → uses playwright-core with browsers from `npx playwright install`
 *
 * All consumer files should import from here instead of importing playwright directly.
 */
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core';

export type { Browser, Page, BrowserContext };

const IS_SERVERLESS =
  !!process.env.VERCEL ||
  !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
  !!process.env.AWS_EXECUTION_ENV;

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
];

/**
 * Launch a fresh browser instance.
 * Caller is responsible for closing it when done.
 */
export async function launchBrowser(options?: {
  headless?: boolean;
  args?: string[];
}): Promise<Browser> {
  if (IS_SERVERLESS) {
    const sparticuz = (await import('@sparticuz/chromium')).default;

    return chromium.launch({
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
      headless: true,
    });
  }

  return chromium.launch({
    headless: options?.headless ?? true,
    args: options?.args ?? DEFAULT_ARGS,
  });
}

/**
 * Singleton browser — reuses one instance across requests within the same
 * serverless invocation (warm starts). Falls back to launching a new one
 * if the previous instance disconnected.
 */
let _singleton: Browser | null = null;

export async function getSingletonBrowser(): Promise<Browser> {
  if (_singleton && _singleton.isConnected()) return _singleton;
  _singleton = await launchBrowser();
  return _singleton;
}
