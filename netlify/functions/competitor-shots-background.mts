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

const IS_SERVERLESS =
  !!process.env.NETLIFY && !process.env.NETLIFY_LOCAL && !process.env.NETLIFY_DEV;
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

/** Full-page JPEG of a URL at the given device profile. */
async function capture(browser: Browser, url: string, device: 'desktop' | 'mobile'): Promise<Buffer | null> {
  const viewport = device === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
  const context = await browser.newContext({
    userAgent: device === 'mobile' ? MOBILE_UA : DESKTOP_UA,
    viewport,
    deviceScaleFactor: device === 'mobile' ? 2 : 1,
    isMobile: device === 'mobile',
    hasTouch: device === 'mobile',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    }
    await page.waitForTimeout(1500);
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let total = 0;
          const step = 700;
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight - window.innerHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              setTimeout(resolve, 500);
            }
          }, 100);
        });
      });
    } catch { /* CSP/eval blocked */ }
    const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    const clip = Math.min(MAX_HEIGHT, pageHeight || MAX_HEIGHT);
    return (await page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage: clip >= (pageHeight || 0),
      clip: clip < (pageHeight || 0) ? { x: 0, y: 0, width: viewport.width, height: clip } : undefined,
    })) as Buffer;
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

  const { data: rows } = await sb
    .from('archived_funnels')
    .select('id, steps')
    .eq('project_id', projectId);

  const todo: Array<{ id: string; url: string; step: Record<string, unknown> }> = [];
  for (const r of (rows || []) as Array<{ id: string; steps?: unknown }>) {
    const step = Array.isArray(r.steps) ? (r.steps[0] as Record<string, unknown>) : null;
    const cd = step?.cloned_data as Record<string, unknown> | undefined;
    if (!step || !cd) continue;
    if (step.page_type !== 'landing') continue;
    if (cd.screenshotDesktopUrl || cd.screenshotMobileUrl) continue; // already done
    const src = typeof cd.source_url === 'string' ? cd.source_url : '';
    if (!/^https?:\/\//i.test(src)) continue;
    todo.push({ id: r.id, url: src, step });
  }

  if (todo.length === 0) return new Response(JSON.stringify({ ok: true, done: 0 }), { status: 200 });
  log(`capturing ${Math.min(todo.length, MAX_LANDINGS)} landing(s)`);

  let browser: Browser | null = null;
  let done = 0;
  try {
    browser = await launchBrowser();
    for (const t of todo.slice(0, MAX_LANDINGS)) {
      let d: Buffer | null = null;
      let m: Buffer | null = null;
      try { d = await capture(browser, t.url, 'desktop'); } catch (e) { log('desktop fail', t.url, (e as Error).message); }
      try { m = await capture(browser, t.url, 'mobile'); } catch (e) { log('mobile fail', t.url, (e as Error).message); }
      const [dUrl, mUrl] = await Promise.all([
        d ? uploadShot(sb, t.id, 'desktop', d) : Promise.resolve(null),
        m ? uploadShot(sb, t.id, 'mobile', m) : Promise.resolve(null),
      ]);
      if (!dUrl && !mUrl) continue;
      const cd = t.step.cloned_data as Record<string, unknown>;
      cd.screenshotDesktopUrl = dUrl;
      cd.screenshotMobileUrl = mUrl;
      cd.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(t.id)}&kind=cloned&variant=desktop&v=${Date.now()}`;
      await sb.from('archived_funnels').update({ steps: [t.step] }).eq('id', t.id);
      done++;
      log(`saved shots for ${t.url} (${done})`);
    }
  } catch (e) {
    log('FATAL', (e as Error).message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, done }), { status: 200 });
};
