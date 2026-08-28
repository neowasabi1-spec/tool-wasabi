/**
 * TEMPORARY — backfill desktop+mobile screenshots for recovered archive pages.
 *
 * The archive wipe lost the screenshot URLs; the HTML survived in `page_html`.
 * For every step missing `screenshotDesktopUrl` we render the SAVED HTML in
 * headless Chromium (desktop 1280 / mobile 390, full page) and upload JPEGs to
 * the same `media/extension-captures/{pageId}/` path the extension uses.
 *
 * Token-guarded, batched (call repeatedly until remaining=0). REMOVE after use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { launchBrowser, type Browser } from '@/lib/get-browser';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

const TOKEN = 'wsb-diag-8f3a1c6e2b';
const MAX_SHOT_HEIGHT = 9000;

interface StepData {
  page_id?: string;
  cloned_data?: {
    html?: string;
    htmlUrl?: string;
    screenshotDesktopUrl?: string | null;
    screenshotMobileUrl?: string | null;
    shotBackfillFailed?: boolean;
    shotBackfillTries?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface Row {
  id: string;
  name: string;
  steps: StepData[];
  project_id: string | null;
}

async function loadHtml(pageId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('page_html')
    .select('html')
    .eq('page_id', pageId)
    .eq('kind', 'cloned')
    .eq('variant', 'desktop')
    .maybeSingle();
  return (data?.html as string) || '';
}

async function shoot(
  browser: Browser,
  html: string,
  variant: 'desktop' | 'mobile',
): Promise<Buffer | null> {
  const viewport = variant === 'desktop' ? { width: 1280, height: 800 } : { width: 390, height: 844 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: variant === 'mobile',
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    userAgent:
      variant === 'mobile'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
        : undefined,
  });
  try {
    // Videos eat the little memory Chromium has on Netlify — skip them.
    await context.route(/\.(mp4|webm|mov|avi|m3u8|ts)(\?|$)/i, (r) => r.abort().catch(() => {}));
    const page = await context.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {
      /* very heavy pages: capture whatever rendered */
    }
    await page.waitForTimeout(2500);
    // Trigger lazy-loaded images before the capture.
    try {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let total = 0;
          const interval = setInterval(() => {
            window.scrollBy(0, 800);
            total += 800;
            if (total >= document.body.scrollHeight - window.innerHeight || total > 15000) {
              clearInterval(interval);
              window.scrollTo(0, 0);
              setTimeout(resolve, 400);
            }
          }, 80);
        });
      });
    } catch { /* CSP or empty body — capture anyway */ }

    const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    const clipHeight = Math.min(MAX_SHOT_HEIGHT, pageHeight || viewport.height);
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 72,
      fullPage: clipHeight >= (pageHeight || 0),
      clip:
        clipHeight < (pageHeight || 0)
          ? { x: 0, y: 0, width: viewport.width, height: clipHeight }
          : undefined,
    });
    return buffer;
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

async function upload(pageId: string, variant: 'desktop' | 'mobile', buffer: Buffer): Promise<string | null> {
  const path = `extension-captures/${pageId}/${variant}.jpg`;
  const { error } = await supabaseAdmin.storage
    .from('media')
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (error) return null;
  const { data } = supabaseAdmin.storage.from('media').getPublicUrl(path);
  return data.publicUrl || null;
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // Chromium on Netlify functions is memory-starved and often dies after ONE
  // heavy page — keep batches tiny and relaunch the browser when it drops.
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 2, 3);

  const { data, error } = await supabaseAdmin
    .from('archived_funnels')
    .select('id, name, steps, project_id')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Every step still missing a desktop screenshot. Project-linked rows first
  // (they're the Competitor Landings the user is looking at right now).
  const todo: Array<{ row: Row; stepIdx: number; pageId: string }> = [];
  const rows = (data || []) as Row[];
  const ordered = [...rows.filter((r) => r.project_id), ...rows.filter((r) => !r.project_id)];
  for (const row of ordered) {
    if (!Array.isArray(row.steps)) continue;
    row.steps.forEach((step, i) => {
      const cd = step?.cloned_data;
      if (!cd || cd.screenshotDesktopUrl || cd.shotBackfillFailed) return;
      todo.push({ row, stepIdx: i, pageId: step.page_id || row.id });
    });
  }

  const batch = todo.slice(0, limit);
  let done = 0;
  const errors: string[] = [];

  let browser: Browser | null = null;
  const ensureBrowser = async (): Promise<Browser> => {
    if (browser && browser.isConnected()) return browser;
    if (browser) await browser.close().catch(() => {});
    browser = await launchBrowser();
    return browser;
  };

  try {
    for (const item of batch) {
      const cd = item.row.steps[item.stepIdx].cloned_data!;
      try {
        const html = await loadHtml(item.pageId);
        if (!html || html.length < 200) {
          // No mirror — flag it so we don't retry forever.
          cd.shotBackfillFailed = true;
          await supabaseAdmin.from('archived_funnels').update({ steps: item.row.steps }).eq('id', item.row.id);
          errors.push(`${item.pageId}: no html`);
          continue;
        }
        const desktopBuf = await shoot(await ensureBrowser(), html, 'desktop');
        const mobileBuf = await shoot(await ensureBrowser(), html, 'mobile');
        const desktopUrl = desktopBuf ? await upload(item.pageId, 'desktop', desktopBuf) : null;
        const mobileUrl = mobileBuf ? await upload(item.pageId, 'mobile', mobileBuf) : null;
        if (!desktopUrl) {
          // Chromium probably OOM'd on this page. Retry on a later pass, but
          // give up (and stop blocking the queue) after 3 attempts.
          cd.shotBackfillTries = (cd.shotBackfillTries || 0) + 1;
          if (cd.shotBackfillTries >= 3) cd.shotBackfillFailed = true;
          await supabaseAdmin.from('archived_funnels').update({ steps: item.row.steps }).eq('id', item.row.id);
          errors.push(`${item.pageId}: capture failed (try ${cd.shotBackfillTries})`);
          continue;
        }
        cd.screenshotDesktopUrl = desktopUrl;
        cd.screenshotMobileUrl = mobileUrl || cd.screenshotMobileUrl || '';
        delete cd.shotBackfillTries;
        const { error: uErr } = await supabaseAdmin
          .from('archived_funnels')
          .update({ steps: item.row.steps })
          .eq('id', item.row.id);
        if (uErr) errors.push(`${item.pageId}: ${uErr.message}`);
        else done++;
      } catch (e) {
        errors.push(`${item.pageId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return NextResponse.json({
    version: 2,
    pending: todo.length,
    processed: batch.length,
    done,
    remaining: todo.length - batch.length,
    errors,
  });
}
