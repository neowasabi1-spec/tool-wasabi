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

async function shot(browser: Awaited<ReturnType<typeof launch>>, url: string, device: 'desktop' | 'mobile'): Promise<Buffer> {
  const ctx = await browser.newContext({
    viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: device === 'mobile' ? 2 : 1,
    isMobile: device === 'mobile', hasTouch: device === 'mobile',
    ignoreHTTPSErrors: true, bypassCSP: true,
  });
  const page = await ctx.newPage();
  try {
    try { await page.goto(url, { waitUntil: 'load', timeout: 25_000 }); }
    catch { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }); }
    await page.waitForTimeout(1500);
    const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    const clip = Math.min(18000, h || 18000);
    return (await page.screenshot({ type: 'jpeg', quality: 72, fullPage: clip >= (h || 0), clip: clip < (h || 0) ? { x: 0, y: 0, width: device === 'mobile' ? 390 : 1280, height: clip } : undefined })) as Buffer;
  } finally { await page.close().catch(() => {}); await ctx.close().catch(() => {}); }
}

/** Full job (synchronous): capture desktop+mobile for a project's landings
 *  missing screenshots and patch them. ?projectId=... */
async function runJob(projectId: string, out: Record<string, unknown>) {
  const surl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const skey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  out.hasSupabaseEnv = !!(surl && skey);
  if (!surl || !skey) { out.error = 'no supabase env'; return; }
  const sb = createClient(surl, skey, { auth: { persistSession: false } });
  const { data: rows, error: selErr } = await sb.from('archived_funnels').select('id, steps').eq('project_id', projectId);
  out.selError = selErr ? selErr.message : null;
  out.rowCount = (rows || []).length;
  const todo: Array<{ id: string; url: string; step: Record<string, unknown> }> = [];
  for (const r of (rows || []) as Array<{ id: string; steps?: unknown }>) {
    const step = Array.isArray(r.steps) ? (r.steps[0] as Record<string, unknown>) : null;
    const cd = step?.cloned_data as Record<string, unknown> | undefined;
    if (!step || !cd) continue;
    if (step.page_type !== 'landing') continue;
    if (cd.screenshotDesktopUrl || cd.screenshotMobileUrl) continue;
    const src = typeof cd.source_url === 'string' ? cd.source_url : '';
    if (!/^https?:\/\//i.test(src)) continue;
    todo.push({ id: r.id, url: src, step });
  }
  out.todo = todo.length;
  if (todo.length === 0) return;
  let done = 0;
  const errors: string[] = [];
  {
    for (const t of todo.slice(0, 3)) {
      let d: Buffer | null = null, m: Buffer | null = null;
      let browser: Awaited<ReturnType<typeof launch>> | null = null;
      try {
        browser = await launch();
        try { d = await shot(browser, t.url, 'desktop'); } catch (e) { errors.push(`d:${t.url}:${(e as Error).message}`); }
        try { m = await shot(browser, t.url, 'mobile'); } catch (e) { errors.push(`m:${t.url}:${(e as Error).message}`); }
      } catch (e) { errors.push(`launch:${t.url}:${(e as Error).message}`); }
      finally { if (browser) await browser.close().catch(() => {}); }
      const upload = async (variant: 'desktop' | 'mobile', buf: Buffer | null) => {
        if (!buf) return null;
        const path = `extension-captures/${t.id}/${variant}.jpg`;
        const up = await sb.storage.from('media').upload(path, buf, { contentType: 'image/jpeg', upsert: true });
        if (up.error) { errors.push(`up:${variant}:${up.error.message}`); return null; }
        return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
      };
      const dUrl = await upload('desktop', d);
      const mUrl = await upload('mobile', m);
      if (!dUrl && !mUrl) continue;
      const cd = t.step.cloned_data as Record<string, unknown>;
      cd.screenshotDesktopUrl = dUrl; cd.screenshotMobileUrl = mUrl;
      cd.htmlUrl = `/api/funnel-html?pageId=${encodeURIComponent(t.id)}&kind=cloned&variant=desktop&v=${Date.now()}`;
      const upd = await sb.from('archived_funnels').update({ steps: [t.step] }).eq('id', t.id);
      if (upd.error) errors.push(`db:${t.id}:${upd.error.message}`);
      else done++;
    }
  }
  out.done = done;
  out.errors = errors.slice(0, 8);
}

export default async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const url = params.get('url') || 'https://example.com';
  const projectId = params.get('projectId') || '';
  const doNav = params.get('nav') === '1';
  const out: Record<string, unknown> = { url, serverless: IS_SERVERLESS, doNav, projectId };
  const t0 = Date.now();
  if (projectId) {
    try { await runJob(projectId, out); out.ok = true; }
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
