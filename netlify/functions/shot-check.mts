import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

/** Synchronous diagnostic: verifies headless Chromium can launch + screenshot
 *  inside a standalone Netlify function bundle (not the Next server handler).
 *  GET /.netlify/functions/shot-check?url=... */
const IS_SERVERLESS = !(process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL);
const REMOTE_TAR_URL =
  process.env.CHROMIUM_REMOTE_TAR ||
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

async function launch() {
  let executablePath: string | undefined;
  let args: string[] = ['--disable-dev-shm-usage', '--disable-gpu'];
  if (IS_SERVERLESS) {
    const sparticuz = (await import('@sparticuz/chromium-min')).default as unknown as {
      args: string[]; executablePath: (u?: string) => Promise<string>;
    };
    args = sparticuz.args;
    executablePath = await sparticuz.executablePath(REMOTE_TAR_URL);
  }
  return chromium.launch({ args, executablePath, headless: true });
}

// Mirror the extension: one tab, set the device profile via CDP, capture ONE
// full-page viewport. Single-viewport-per-call keeps each request well within
// the synchronous function budget (a fresh launch is ~13s).
async function captureOne(browser: Awaited<ReturnType<typeof launch>>, url: string, variant: 'desktop' | 'mobile'): Promise<Buffer> {
  // dsf:1 (not retina) for mobile too — a 2x full-page shot is heavy enough to
  // blow the synchronous function budget on tall pages.
  const o = variant === 'mobile'
    ? { width: 390, height: 844, mobile: true, dsf: 1 }
    : { width: 1280, height: 900, mobile: false, dsf: 1 };
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  try {
    await client.send('Page.enable').catch(() => {});
    await client.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.dsf, mobile: o.mobile, screenWidth: o.width, screenHeight: o.height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18_000 }).catch(() => {});
    await page.waitForTimeout(500);
    try {
      await client.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight); void 0;' });
      await page.waitForTimeout(250);
      await client.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0); void 0;' });
      await page.waitForTimeout(150);
    } catch { /* ignore */ }
    const m = (await client.send('Page.getLayoutMetrics')) as { cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } };
    const cs = m.cssContentSize || m.contentSize || { width: o.width, height: o.height };
    // FULL page like the extension (cap only at an absurd 18000px safety limit).
    const res = (await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(cs.width) || o.width, height: Math.min(Math.ceil(cs.height) || o.height, 18000), scale: 1 } })) as { data: string };
    return Buffer.from(res.data, 'base64');
  } finally { await page.close().catch(() => {}); await ctx.close().catch(() => {}); }
}

/** Synchronous single-viewport capture: finds ONE landing in the project still
 *  missing the requested `variant` screenshot, captures + patches it, and
 *  reports how many remain. Call repeatedly (per variant) until remaining = 0.
 *  ?projectId=...&variant=desktop|mobile */
async function runJob(projectId: string, variant: 'desktop' | 'mobile', out: Record<string, unknown>) {
  const surl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const skey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  out.hasSupabaseEnv = !!(surl && skey);
  if (!surl || !skey) { out.error = 'no supabase env'; return; }
  const sb = createClient(surl, skey, { auth: { persistSession: false } });
  const field = variant === 'mobile' ? 'screenshotMobileUrl' : 'screenshotDesktopUrl';
  const { data: rows, error: selErr } = await sb.from('archived_funnels').select('id, steps').eq('project_id', projectId);
  out.selError = selErr ? selErr.message : null;
  out.rowCount = (rows || []).length;

  const pending: Array<{ id: string; url: string; step: Record<string, unknown> }> = [];
  for (const r of (rows || []) as Array<{ id: string; steps?: unknown }>) {
    const step = Array.isArray(r.steps) ? (r.steps[0] as Record<string, unknown>) : null;
    const cd = step?.cloned_data as Record<string, unknown> | undefined;
    if (!step || !cd) continue;
    if (step.page_type !== 'landing') continue;
    if (typeof cd[field] === 'string' && cd[field]) continue; // this variant already done
    const src = typeof cd.source_url === 'string' ? cd.source_url : '';
    if (!/^https?:\/\//i.test(src)) continue;
    pending.push({ id: r.id, url: src, step });
  }
  out.variant = variant;
  out.pending = pending.length;
  if (pending.length === 0) { out.done = 0; out.remaining = 0; return; }

  const t = pending[0];
  const errors: string[] = [];
  let shotUrl: string | null = null;
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    browser = await launch();
    const buf = await captureOne(browser, t.url, variant);
    const path = `extension-captures/${t.id}/${variant}.jpg`;
    const up = await sb.storage.from('media').upload(path, buf, { contentType: 'image/jpeg', upsert: true });
    if (up.error) errors.push(`up:${up.error.message}`);
    else shotUrl = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
  } catch (e) { errors.push(`cap:${(e as Error).message}`); }
  finally { if (browser) await browser.close().catch(() => {}); }

  out.page = t.url;
  if (shotUrl) {
    const cd = t.step.cloned_data as Record<string, unknown>;
    cd[field] = shotUrl;
    cd.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(t.id)}&kind=cloned&variant=desktop&v=${Date.now()}`;
    const upd = await sb.from('archived_funnels').update({ steps: [t.step] }).eq('id', t.id);
    if (upd.error) errors.push(`db:${upd.error.message}`);
    else { out.done = 1; out.remaining = pending.length - 1; }
  } else {
    out.done = 0; out.remaining = pending.length;
  }
  out.errors = errors.slice(0, 8);
}

export default async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const url = params.get('url') || 'https://example.com';
  const projectId = params.get('projectId') || '';
  const variant = params.get('variant') === 'mobile' ? 'mobile' : 'desktop';
  const doNav = params.get('nav') === '1';
  const out: Record<string, unknown> = { url, serverless: IS_SERVERLESS, doNav, projectId };
  const t0 = Date.now();
  if (projectId) {
    try { await runJob(projectId, variant, out); out.ok = true; }
    catch (e) { out.ok = false; out.error = (e as Error).message; out.stack = (e as Error).stack?.split('\n').slice(0, 5).join(' | '); }
    out.totalMs = Date.now() - t0;
    return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
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
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(2000);
        const buf = (await page.screenshot({ type: 'jpeg', quality: 72 })) as Buffer;
        out.bytes = buf.length;
        out.navMs = Date.now() - t0;
        // Upload test to the same public bucket the grid reads from.
        const surl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
        const skey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
        out.hasSupabaseEnv = !!(surl && skey);
        if (surl && skey) {
          const sb = createClient(surl, skey, { auth: { persistSession: false } });
          const path = `extension-captures/_diag/desktop.jpg`;
          const up = await sb.storage.from('media').upload(path, buf, { contentType: 'image/jpeg', upsert: true });
          out.uploadError = up.error ? up.error.message : null;
          if (!up.error) out.publicUrl = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
        }
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
