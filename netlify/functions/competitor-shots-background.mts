import { createClient } from '@supabase/supabase-js';
import { chromium, type Browser } from 'playwright-core';

/**
 * Background function (up to 15 min) that renders DESKTOP + MOBILE screenshots
 * for a project's competitor landing pages and patches them into the
 * archived_funnels rows — exactly like the browser extension's previews.
 *
 * Decoupled from the Apify webhook so heavy Playwright work never competes
 * with ad ingestion for the webhook's 300s budget.
 *
 * Body: { projectId, secret }
 */

// A standalone Netlify function runs either under `netlify dev` locally or on
// the Netlify (AWS Lambda) cloud. Unlike the Next server handler, NETLIFY is
// NOT reliably set in the standalone function runtime, so default to the
// serverless (Sparticuz) Chromium path unless we detect a local dev run.
const IS_SERVERLESS = !(process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL);
const REMOTE_TAR_URL =
  process.env.CHROMIUM_REMOTE_TAR ||
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

// Match the browser extension's capture viewports exactly.
const DESKTOP_VIEWPORT = { width: 1280, height: 900 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const MAX_HEIGHT = 18_000;
const MAX_LANDINGS = 12;

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Supabase env (URL / SERVICE_ROLE_KEY) missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type SupabaseClient = ReturnType<typeof getSupabase>;

async function launchBrowser(): Promise<Browser> {
  if (IS_SERVERLESS) {
    const sparticuz = (await import('@sparticuz/chromium-min')).default as unknown as {
      args: string[];
      executablePath: (url?: string) => Promise<string>;
    };
    const executablePath = await sparticuz.executablePath(REMOTE_TAR_URL);
    return chromium.launch({ args: sparticuz.args, executablePath, headless: true });
  }
  return chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
}

/** Capture DESKTOP + MOBILE full-page JPEGs of a URL in ONE tab, exactly like
 *  the browser extension (background.js): a single page + navigation, switching
 *  device profiles via CDP Emulation.setDeviceMetricsOverride. This is critical
 *  on serverless Chromium (--single-process): opening a SECOND context/page
 *  crashes the renderer ("Target/context/browser has been closed"), so we must
 *  reuse one page and one CDP session for both viewports. */
async function captureBoth(
  browser: Browser,
  url: string,
): Promise<{ desktop: Buffer | null; mobile: Buffer | null }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  const shot = async (o: { width: number; height: number; mobile: boolean; dsf: number }): Promise<Buffer> => {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: o.width,
      height: o.height,
      deviceScaleFactor: o.dsf,
      mobile: o.mobile,
      screenWidth: o.width,
      screenHeight: o.height,
    });
    await page.waitForTimeout(700);
    try {
      await client.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight); void 0;' });
      await page.waitForTimeout(400);
      await client.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); void 0;' });
      await page.waitForTimeout(200);
    } catch { /* ignore */ }
    const metrics = (await client.send('Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const cs = metrics.cssContentSize || metrics.contentSize || { width: o.width, height: o.height };
    const shotWidth = Math.ceil(cs.width) || o.width;
    const shotHeight = Math.min(Math.ceil(cs.height) || o.height, MAX_HEIGHT);
    const res = (await client.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 72,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: shotWidth, height: shotHeight, scale: 1 },
    })) as { data: string };
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    return Buffer.from(res.data, 'base64');
  };

  try {
    await client.send('Page.enable').catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForTimeout(900); // let hero media + fonts settle
    let desktop: Buffer | null = null;
    let mobile: Buffer | null = null;
    try { desktop = await shot({ width: 1280, height: 900, mobile: false, dsf: 1 }); } catch { /* record upstream */ }
    try { mobile = await shot({ width: 390, height: 844, mobile: true, dsf: 2 }); } catch { /* record upstream */ }
    return { desktop, mobile };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function uploadShot(
  sb: SupabaseClient,
  pageId: string,
  variant: 'desktop' | 'mobile',
  buffer: Buffer,
): Promise<string | null> {
  const path = `extension-captures/${pageId}/${variant}.jpg`;
  const { error } = await sb.storage
    .from('media')
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (error) return null;
  const { data } = sb.storage.from('media').getPublicUrl(path);
  return data.publicUrl || null;
}

export default async (req: Request) => {
  let projectId = '';
  let secret = '';
  try {
    const body = (await req.json()) as { projectId?: string; secret?: string };
    projectId = String(body?.projectId || '');
    secret = String(body?.secret || '');
  } catch { /* ignore */ }

  const expected = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  if (expected && secret !== expected) return new Response('Unauthorized', { status: 401 });
  if (!projectId) return new Response('missing projectId', { status: 200 });

  const log = (...a: unknown[]) => console.log(`[shots ${projectId}]`, ...a);
  const sb = getSupabase();

  // Observability: background functions can't be tailed here, so we mirror
  // progress into a small JSON in the public media bucket that we can curl.
  const diag: Record<string, unknown> = { projectId, startedAt: new Date().toISOString(), stage: 'entry' };
  const writeDiag = async () => {
    try {
      await sb.storage.from('media').upload(
        `extension-captures/_diag/${projectId}.json`,
        Buffer.from(JSON.stringify(diag, null, 2)),
        { contentType: 'application/json', upsert: true },
      );
    } catch { /* diag is best-effort */ }
  };
  await writeDiag();

  try {
    return await runShots();
  } catch (e) {
    diag.stage = 'fatal';
    diag.error = (e as Error).message;
    diag.stack = (e as Error).stack?.split('\n').slice(0, 6).join(' | ');
    await writeDiag();
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 200 });
  }

  async function runShots(): Promise<Response> {
  const { data: rows, error: selErr } = await sb
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId);
  diag.selError = selErr ? selErr.message : null;
  diag.rowCount = (rows || []).length;

  const todo: Array<{ id: string; url: string; step: Record<string, unknown> }> = [];
  for (const r of (rows || []) as Array<{ id: string; steps?: unknown }>) {
    const step = Array.isArray(r.steps) ? (r.steps[0] as Record<string, unknown>) : null;
    const cd = step?.cloned_data as Record<string, unknown> | undefined;
    if (!step || !cd) continue;
    if (step.page_type !== 'landing') continue;
    if (cd.screenshotDesktopUrl && cd.screenshotMobileUrl) continue; // both done
    const src = typeof cd.source_url === 'string' ? cd.source_url : '';
    if (!/^https?:\/\//i.test(src)) continue;
    todo.push({ id: r.id, url: src, step });
  }

  diag.todo = todo.length;
  diag.stage = 'todo';
  await writeDiag();
  if (todo.length === 0) {
    diag.stage = 'done'; diag.done = 0; await writeDiag();
    return new Response(JSON.stringify({ ok: true, done: 0 }), { status: 200 });
  }
  log(`capturing ${Math.min(todo.length, MAX_LANDINGS)} landing(s)`);

  const results: Array<Record<string, unknown>> = [];
  let done = 0;
  for (const t of todo.slice(0, MAX_LANDINGS)) {
    const cd = t.step.cloned_data as Record<string, unknown>;
    const errs: string[] = [];
    let dUrl: string | null = typeof cd.screenshotDesktopUrl === 'string' ? cd.screenshotDesktopUrl : null;
    let mUrl: string | null = typeof cd.screenshotMobileUrl === 'string' ? cd.screenshotMobileUrl : null;

    // Fresh browser per landing; both viewports captured in ONE tab via CDP.
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const shots = await captureBoth(browser, t.url);
      if (!dUrl && shots.desktop) {
        dUrl = await uploadShot(sb, t.id, 'desktop', shots.desktop);
        if (!dUrl) errs.push('desktop upload failed');
      } else if (!shots.desktop) errs.push('desktop capture empty');
      if (!mUrl && shots.mobile) {
        mUrl = await uploadShot(sb, t.id, 'mobile', shots.mobile);
        if (!mUrl) errs.push('mobile upload failed');
      } else if (!shots.mobile) errs.push('mobile capture empty');
    } catch (e) {
      errs.push(`capture: ${(e as Error).message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    if (dUrl) {
      cd.screenshotDesktopUrl = dUrl;
      cd.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(t.id)}&kind=cloned&variant=desktop&v=${Date.now()}`;
    }
    if (mUrl) cd.screenshotMobileUrl = mUrl;
    if (errs.length) cd.shotError = errs.join(' | ');
    else delete cd.shotError;
    await sb.from('archived_funnels').update({ steps: [t.step] }).eq('id', t.id).then(() => undefined, () => undefined);

    if (dUrl || mUrl) { done++; log(`saved shots for ${t.url} (${done})`); }
    else log(`no shots for ${t.url}: ${errs.join(' | ')}`);

    results.push({ url: t.url, d: !!dUrl, m: !!mUrl, err: errs.join(' | ') || null });
    diag.stage = 'progress'; diag.done = done; diag.results = results; await writeDiag();
  }

  diag.stage = 'done';
  diag.done = done;
  diag.finishedAt = new Date().toISOString();
  await writeDiag();
  return new Response(JSON.stringify({ ok: true, done }), { status: 200 });
  }
};
