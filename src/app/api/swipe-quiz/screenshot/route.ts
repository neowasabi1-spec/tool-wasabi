import { NextRequest, NextResponse } from 'next/server';
import { launchBrowser, type Browser } from '@/lib/get-browser';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const SCREENSHOT_TIMEOUT_MS = 60_000;

export interface CssTokens {
  body: CssElementTokens | null;
  heading: CssElementTokens | null;
  button: CssElementTokens | null;
  card: CssElementTokens | null;
  progressBar: CssElementTokens | null;
  container: CssElementTokens | null;
  link: CssElementTokens | null;
}

export interface CssElementTokens {
  color: string;
  bg: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  borderRadius: string;
  padding: string;
  boxShadow: string;
  border: string;
  lineHeight: string;
  maxWidth: string;
}

export async function POST(request: NextRequest) {
  let browser: Browser | null = null;

  try {
    const { url, viewport, extractCss } = (await request.json()) as {
      url: string;
      viewport?: { width?: number; height?: number };
      extractCss?: boolean;
    };

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'The "url" field is required' },
        { status: 400 }
      );
    }

    browser = await launchBrowser();

    const context = await browser.newContext({
      viewport: {
        width: viewport?.width || 1280,
        height: viewport?.height || 800,
      },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    // Wait a bit for animations/lazy content
    await page.waitForTimeout(2000);

    // Try to dismiss cookie banners or popups
    try {
      const dismissSelectors = [
        '[class*="cookie"] button',
        '[class*="consent"] button',
        '[class*="popup"] [class*="close"]',
        '[class*="modal"] [class*="close"]',
        'button[aria-label="Close"]',
        'button[aria-label="Chiudi"]',
      ];
      for (const sel of dismissSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    } catch {
      // Ignore dismiss errors
    }

    const buf = await page.screenshot({
      fullPage: true,
      type: 'png',
      timeout: SCREENSHOT_TIMEOUT_MS,
    });

    const screenshotBase64 = buf.toString('base64');
    const title = await page.title();

    // Extract computed CSS tokens from key DOM elements
    let cssTokens: CssTokens | null = null;
    if (extractCss !== false) {
      try {
        cssTokens = await page.evaluate(() => {
          function getTokens(selectors: string[]): CssElementTokens | null {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const s = window.getComputedStyle(el);
              return {
                color: s.color,
                bg: s.backgroundColor,
                fontFamily: s.fontFamily,
                fontSize: s.fontSize,
                fontWeight: s.fontWeight,
                borderRadius: s.borderRadius,
                padding: s.padding,
                boxShadow: s.boxShadow,
                border: s.border,
                lineHeight: s.lineHeight,
                maxWidth: s.maxWidth,
              };
            }
            return null;
          }

          return {
            body: getTokens(['body']),
            heading: getTokens([
              'h1', 'h2', '[class*="title"]', '[class*="heading"]',
              '[class*="headline"]', '[class*="question"]',
            ]),
            button: getTokens([
              'button[class*="cta"]', 'button[class*="primary"]',
              'button[class*="btn"]', 'a[class*="cta"]', 'a[class*="btn"]',
              'button:not([class*="close"]):not([class*="dismiss"])',
            ]),
            card: getTokens([
              '[class*="option"]', '[class*="card"]', '[class*="answer"]',
              '[class*="choice"]', '[class*="item"]',
            ]),
            progressBar: getTokens([
              '[class*="progress"]', '[role="progressbar"]',
              '[class*="step-indicator"]', '[class*="stepper"]',
            ]),
            container: getTokens([
              '[class*="container"]', '[class*="wrapper"]',
              'main', '[class*="content"]', '[class*="quiz"]',
            ]),
            link: getTokens(['a[href]', '[class*="link"]']),
          };
        });
      } catch {
        // CSS extraction is best-effort, continue without it
      }
    }

    await browser.close();
    browser = null;

    return NextResponse.json({
      success: true,
      screenshot: screenshotBase64,
      title,
      url,
      size: screenshotBase64.length,
      cssTokens,
    });
  } catch (error) {
    console.error('Screenshot error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Screenshot error',
      },
      { status: 500 }
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
