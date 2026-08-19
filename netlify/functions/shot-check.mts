import { chromium } from 'playwright-core';

/** Synchronous diagnostic: verifies headless Chromium can launch + screenshot
 *  inside a standalone Netlify function bundle (not the Next server handler).
 *  GET /.netlify/functions/shot-check?url=... */
const IS_SERVERLESS = !(process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL);
const REMOTE_TAR_URL =
  process.env.CHROMIUM_REMOTE_TAR ||
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

export default async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const url = params.get('url') || 'https://example.com';
  const doNav = params.get('nav') === '1';
  const out: Record<string, unknown> = { url, serverless: IS_SERVERLESS, doNav };
  const t0 = Date.now();
  try {
    let executablePath: string | undefined;
    let args: string[] = ['--disable-dev-shm-usage', '--disable-gpu'];
    if (IS_SERVERLESS) {
      const sparticuz = (await import('@sparticuz/chromium-min')).default as unknown as {
        args: string[]; executablePath: (u?: string) => Promise<string>;
      };
      args = sparticuz.args;
      executablePath = await sparticuz.executablePath(REMOTE_TAR_URL);
      out.executablePath = executablePath;
    }
    out.resolveMs = Date.now() - t0;
    const browser = await chromium.launch({ args, executablePath, headless: true });
    out.launchMs = Date.now() - t0;
    out.launched = true;
    try {
      if (doNav) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
        const buf = await page.screenshot({ type: 'jpeg', quality: 72 });
        out.bytes = buf.length;
        await ctx.close().catch(() => {});
      }
      out.ok = true;
      out.totalMs = Date.now() - t0;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    out.ok = false;
    out.error = (e as Error).message;
    out.stack = (e as Error).stack?.split('\n').slice(0, 5).join(' | ');
    out.failMs = Date.now() - t0;
  }
  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
