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
  // Accept projectId + secret from the query string OR the JSON body — the
  // pipeline posts a JSON body; the query string is a robust fallback.
  // scope=all → sweep EVERY archived page missing shots (used to backfill the
  // recovered archive), instead of a single project's landings.
  const qs = new URL(req.url).searchParams;
  let projectId = qs.get('projectId') || '';
  let secret = qs.get('secret') || '';
  let scope = qs.get('scope') || '';
  try {
    const body = (await req.json()) as { projectId?: string; secret?: string; scope?: string };
    if (!projectId) projectId = String(body?.projectId || '');
    if (!secret) secret = String(body?.secret || '');
    if (!scope) scope = String(body?.scope || '');
  } catch { /* body may be absent for a query-string invocation */ }

  const expected = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  if (expected && secret !== expected) return new Response('Unauthorized', { status: 401 });
  const sweepAll = scope === 'all';
  if (!projectId && !sweepAll) return new Response('missing projectId', { status: 200 });

  const log = (...a: unknown[]) => console.log(`[shots ${sweepAll ? 'ALL' : projectId}]`, ...a);
  const sb = getSupabase();

  let query = sb.from('archived_funnels').select('id, steps').order('created_at', { ascending: false });
  if (!sweepAll) query = query.eq('project_id', projectId);
  const { data: rows } = await query;

  // One work item per STEP missing a screenshot — covers single-page saves,
  // multi-step walk folders, and every page type (advertorial, checkout,
  // upsell… not just 'landing': the Competitor Library shows them all).
  type Todo = { rowId: string; stepIdx: number; shotKey: string; url: string };
  const stepsByRow = new Map<string, Record<string, unknown>[]>();
  const todo: Todo[] = [];
  for (const r of (rows || []) as Array<{ id: string; steps?: unknown }>) {
    const steps = Array.isArray(r.steps) ? (r.steps as Record<string, unknown>[]) : [];
    if (!steps.length) continue;
    stepsByRow.set(r.id, steps);
    steps.forEach((step, i) => {
      const cd = step?.cloned_data as Record<string, unknown> | undefined;
      if (!cd) return;
      if (cd.screenshotDesktopUrl && cd.screenshotMobileUrl) return; // both done
      const src = typeof cd.source_url === 'string' ? cd.source_url : '';
      if (!/^https?:\/\//i.test(src)) return;
      const shotKey = typeof step.page_id === 'string' && step.page_id ? (step.page_id as string) : r.id;
      todo.push({ rowId: r.id, stepIdx: i, shotKey, url: src });
    });
  }

  if (todo.length === 0) return new Response(JSON.stringify({ ok: true, done: 0, remaining: 0 }), { status: 200 });
  log(`capturing ${Math.min(todo.length, MAX_LANDINGS)} of ${todo.length} page(s)`);

  let done = 0;
  const batch = todo.slice(0, MAX_LANDINGS);
  for (const t of batch) {
    const steps = stepsByRow.get(t.rowId)!;
    const step = steps[t.stepIdx];
    const cd = step.cloned_data as Record<string, unknown>;
    const errs: string[] = [];
    let dUrl: string | null = typeof cd.screenshotDesktopUrl === 'string' ? cd.screenshotDesktopUrl : null;
    let mUrl: string | null = typeof cd.screenshotMobileUrl === 'string' ? cd.screenshotMobileUrl : null;

    // Fresh browser per landing; both viewports captured in ONE tab via CDP.
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const shots = await captureBoth(browser, t.url);
      if (!dUrl && shots.desktop) {
        dUrl = await uploadShot(sb, t.shotKey, 'desktop', shots.desktop);
        if (!dUrl) errs.push('desktop upload failed');
      } else if (!dUrl && !shots.desktop) errs.push('desktop capture empty');
      if (!mUrl && shots.mobile) {
        mUrl = await uploadShot(sb, t.shotKey, 'mobile', shots.mobile);
        if (!mUrl) errs.push('mobile upload failed');
      } else if (!mUrl && !shots.mobile) errs.push('mobile capture empty');
    } catch (e) {
      errs.push(`capture: ${(e as Error).message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    if (dUrl) cd.screenshotDesktopUrl = dUrl;
    if (mUrl) cd.screenshotMobileUrl = mUrl;
    if (errs.length) cd.shotError = errs.join(' | ');
    else delete cd.shotError;
    await sb.from('archived_funnels').update({ steps }).eq('id', t.rowId).then(() => undefined, () => undefined);

    if (dUrl || mUrl) { done++; log(`saved shots for ${t.url} (${done})`); }
    else log(`no shots for ${t.url}: ${errs.join(' | ')}`);
  }

  return new Response(
    JSON.stringify({ ok: true, done, remaining: todo.length - batch.length }),
    { status: 200 },
  );
};
