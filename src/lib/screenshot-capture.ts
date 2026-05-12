/**
 * Screenshot capture for Checkpoint visual audit.
 *
 * Loads a URL with Playwright at MOBILE viewport (390x844, the
 * iPhone 14/15 logical width — 90%+ of cold FB/TT traffic) and
 * returns a JPEG buffer of the full page.
 *
 * Why mobile only?
 * - The Visual audit prompt explicitly states mobile is the primary
 *   device. Desktop adds 2x cost (storage + tokens) for a marginal
 *   signal.
 * - Anthropic accepts up to ~100 images per request but bills
 *   per-image. We cap at one image per step to stay under the
 *   payload + cost cliff for funnels with many steps.
 *
 * Why JPEG quality 75?
 * - PNG full-page screenshots of long sales pages are 1.5–4MB each
 *   → blow the Anthropic 5MB-per-image limit and balloon the image
 *   tokens. JPEG q=75 lands at ~150–500KB, still readable for the
 *   model on text + UI structure.
 *
 * Why a separate Playwright launch (not piggyback on fetchHtmlSmart)?
 * - fetchHtmlSmart's Playwright path renders at desktop 1440x900 and
 *   only triggers when the page is detected as SPA shell. The visual
 *   audit needs the mobile rendering of EVERY page (SPA or not), so
 *   we run a dedicated launch with the right viewport here.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { launchBrowser, type Browser } from '@/lib/get-browser';

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/' +
  '605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

/** Logical viewport for mobile capture. iPhone 14/15 standard. */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

export interface ScreenshotResult {
  ok: boolean;
  /** JPEG buffer when ok=true. */
  buffer: Buffer | null;
  /** Wall-clock duration including Playwright cold start. */
  durationMs: number;
  /** Final captured page height (for debugging). */
  pageHeight?: number;
  /** Error message when ok=false. */
  error?: string;
}

export interface CaptureScreenshotOptions {
  /** Page-load timeout in ms. Defaults to 35s — long sales pages
   *  often need 20–30s to settle their hero videos / lazy images. */
  timeoutMs?: number;
  /** JPEG quality 1-100. Defaults to 75 (sweet spot for text-readable
   *  full-page screenshots that still fit Anthropic's 5MB limit). */
  quality?: number;
  /** Cap on captured page height in pixels. Anthropic resizes
   *  oversized images down to ~1568px on the long edge anyway, so
   *  capping at 12000px (≈ 5 viewports) keeps the image lean while
   *  still showing the offer + CTA section. */
  maxHeightPx?: number;
  /** Reuse an already-launched browser (saves 5–10s on repeat calls
   *  inside the same request). When omitted we launch our own. */
  browser?: Browser;
}

/**
 * Capture a full-page mobile screenshot for the given URL.
 * Returns null buffer + error on any failure (never throws).
 */
export async function captureMobileScreenshot(
  url: string,
  opts: CaptureScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 35000;
  const quality = Math.max(1, Math.min(100, opts.quality ?? 75));
  const maxHeightPx = opts.maxHeightPx ?? 12000;

  let browser: Browser | null = null;
  let ownsBrowser = false;
  try {
    if (opts.browser) {
      browser = opts.browser;
    } else {
      browser = await launchBrowser();
      ownsBrowser = true;
    }

    const context = await browser.newContext({
      userAgent: MOBILE_USER_AGENT,
      viewport: MOBILE_VIEWPORT,
      // iPhone DPR — keeps text crisp without 3x file-size penalty.
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    const page = await context.newPage();

    try {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: timeoutMs,
        });
      } catch (gotoErr) {
        // networkidle is too strict for some sites; fall back to load.
        const m = gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
        console.warn(
          `[screenshot] networkidle failed for ${url} (${m}); retrying with waitUntil=load`,
        );
        await page.goto(url, {
          waitUntil: 'load',
          timeout: Math.max(15000, timeoutMs - 5000),
        });
      }

      // Hydration grace + give lazy-loaded hero media a chance.
      await page.waitForTimeout(2000);

      // Scroll the full page so lazy-load images trigger before
      // the screenshot, then jump back to top for the capture.
      try {
        await page.evaluate(async () => {
          await new Promise<void>((resolve) => {
            let total = 0;
            const step = 600;
            const interval = setInterval(() => {
              window.scrollBy(0, step);
              total += step;
              if (total >= document.body.scrollHeight - window.innerHeight) {
                clearInterval(interval);
                window.scrollTo(0, 0);
                setTimeout(resolve, 500);
              }
            }, 120);
          });
        });
      } catch {
        // Non-fatal: a strict CSP or about:blank page might block
        // the eval. We still capture whatever rendered.
      }

      const pageHeight = await page
        .evaluate(() => document.body.scrollHeight)
        .catch(() => 0);

      // Cap the captured height so we don't ship a 30-viewport monster.
      const clipHeight = Math.min(maxHeightPx, pageHeight || maxHeightPx);
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality,
        fullPage: clipHeight >= (pageHeight || 0),
        clip:
          clipHeight < (pageHeight || 0)
            ? {
                x: 0,
                y: 0,
                width: MOBILE_VIEWPORT.width,
                height: clipHeight,
              }
            : undefined,
      });

      console.log(
        `[screenshot] captured ${url} (${buffer.length} bytes, pageHeight=${pageHeight}, clip=${clipHeight}, ${Date.now() - t0}ms)`,
      );
      return {
        ok: true,
        buffer,
        durationMs: Date.now() - t0,
        pageHeight,
      };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[screenshot] FAILED for ${url} after ${Date.now() - t0}ms: ${msg}`,
    );
    return {
      ok: false,
      buffer: null,
      durationMs: Date.now() - t0,
      error: msg,
    };
  } finally {
    if (ownsBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ── Supabase Storage upload ──────────────────────────────────────────

/** Bucket where Checkpoint screenshots live. PUBLIC because Anthropic
 *  must be able to download the image when fed as a URL content block.
 *  Created on-first-write via `ensureScreenshotBucket()` if missing
 *  (idempotent, low cost — Supabase short-circuits when present). */
export const CHECKPOINT_SCREENSHOT_BUCKET = 'checkpoint-screenshots';

let _adminClient: SupabaseClient | null = null;
function getAdminClient(): SupabaseClient {
  if (_adminClient) return _adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase env missing — set NEXT_PUBLIC_SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  _adminClient = createClient(url, key, { auth: { persistSession: false } });
  return _adminClient;
}

let _bucketReady: Promise<boolean> | null = null;

/** Idempotent: creates the bucket on first call, no-ops afterwards.
 *  Failure to create (e.g. anon key without storage admin grant) is
 *  swallowed — the upload step will surface a clearer error if the
 *  bucket truly doesn't exist. */
export async function ensureScreenshotBucket(): Promise<boolean> {
  if (_bucketReady) return _bucketReady;
  _bucketReady = (async () => {
    const sb = getAdminClient();
    try {
      const { data: existing } = await sb.storage.getBucket(
        CHECKPOINT_SCREENSHOT_BUCKET,
      );
      if (existing) return true;
    } catch {
      // listBuckets/getBucket may fail with non-admin keys — fall
      // through to createBucket which we wrap in its own try.
    }
    try {
      const { error } = await sb.storage.createBucket(
        CHECKPOINT_SCREENSHOT_BUCKET,
        {
          public: true,
          fileSizeLimit: 5 * 1024 * 1024, // matches Anthropic's per-image limit
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        },
      );
      if (error && !/already exists/i.test(error.message)) {
        console.warn(
          `[screenshot] could not create bucket "${CHECKPOINT_SCREENSHOT_BUCKET}": ${error.message}. Run the supabase-migration-checkpoint-screenshots.sql migration.`,
        );
        return false;
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[screenshot] createBucket threw for "${CHECKPOINT_SCREENSHOT_BUCKET}": ${msg}. Run the SQL migration.`,
      );
      return false;
    }
  })();
  return _bucketReady;
}

export interface UploadScreenshotResult {
  ok: boolean;
  publicUrl: string | null;
  storagePath: string;
  bytes: number;
  durationMs: number;
  error?: string;
}

/**
 * Upload a screenshot buffer to the public Checkpoint bucket.
 * Returns the public URL on success.
 *
 * Path scheme: `{runId}/step-{index}-mobile.jpg`
 * - runId scopes the screenshots to the run that produced them, so
 *   subsequent runs of the same funnel don't clobber each other and
 *   we can later add a TTL cleanup keyed on runId.
 */
export async function uploadCheckpointScreenshot(args: {
  runId: string;
  stepIndex: number;
  buffer: Buffer;
  /** 'mobile' | 'desktop' — currently only 'mobile' is captured. */
  viewport?: 'mobile' | 'desktop';
  contentType?: string;
}): Promise<UploadScreenshotResult> {
  const t0 = Date.now();
  const viewport = args.viewport ?? 'mobile';
  const contentType = args.contentType ?? 'image/jpeg';
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const storagePath = `${args.runId}/step-${args.stepIndex}-${viewport}.${ext}`;

  await ensureScreenshotBucket();

  try {
    const sb = getAdminClient();
    const { error } = await sb.storage
      .from(CHECKPOINT_SCREENSHOT_BUCKET)
      .upload(storagePath, args.buffer, {
        contentType,
        upsert: true,
        cacheControl: '3600',
      });
    if (error) {
      return {
        ok: false,
        publicUrl: null,
        storagePath,
        bytes: args.buffer.length,
        durationMs: Date.now() - t0,
        error: error.message,
      };
    }
    const { data } = sb.storage
      .from(CHECKPOINT_SCREENSHOT_BUCKET)
      .getPublicUrl(storagePath);
    return {
      ok: true,
      publicUrl: data.publicUrl,
      storagePath,
      bytes: args.buffer.length,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      publicUrl: null,
      storagePath,
      bytes: args.buffer.length,
      durationMs: Date.now() - t0,
      error: msg,
    };
  }
}

/**
 * Capture multiple URLs in PARALLEL with bounded concurrency,
 * sharing a single browser instance (faster + lower memory).
 */
export async function captureMobileScreenshotsBatch(
  urls: string[],
  opts: CaptureScreenshotOptions & { concurrency?: number } = {},
): Promise<ScreenshotResult[]> {
  if (urls.length === 0) return [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, urls.length));
  const out: ScreenshotResult[] = new Array(urls.length);

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= urls.length) return;
        out[i] = await captureMobileScreenshot(urls[i], {
          ...opts,
          browser: browser!,
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Browser-launch failure: synthesise per-url errors so callers
    // get a uniform shape and can decide what to do.
    console.error(`[screenshot] batch launch failed: ${msg}`);
    return urls.map(() => ({
      ok: false,
      buffer: null,
      durationMs: 0,
      error: `Browser launch failed: ${msg}`,
    }));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
