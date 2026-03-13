/**
 * Runs the crawl in background. No HTTP timeout - the client receives jobId and polls.
 */
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@/lib/get-browser';
import type {
  FunnelCrawlStep,
  FunnelCrawlLink,
  FunnelCrawlForm,
  FunnelCrawlNetworkRequest,
  FunnelCrawlCookie,
  FunnelCrawlResult,
} from '@/types';
import { updateJob } from './crawl-job-store';

const DEFAULT_MAX_STEPS = 15;
const QUIZ_MAX_STEPS = 20;
const NAV_TIMEOUT_MS = 120_000; // 2 min per page.goto (slow sites like tryrosabella)
const SCREENSHOT_TIMEOUT_MS = 60_000; // 1 min per screenshot (avoids blocking on slow fonts/resources)
const QUIZ_STEP_WAIT_MS = 2500;
const QUIZ_TRANSITION_MS = 1500;
const QUIZ_SAME_FINGERPRINT_MAX = 3;

const TRACKING_PATTERNS = /facebook|google|analytics|pixel|track|doubleclick|hotjar|segment|gtm|tag_manager|clarity|mixpanel|amplitude/i;
const CHECKOUT_PATTERNS = /checkout|cart|pay|stripe|paypal|payment|order|purchase/i;
const QUIZ_NEXT_PATTERNS = /next|continue|avanti|continua|→|submit|get\s*(my|your)?\s*result|see\s*result|claim|claim\s*discount|start|inizia|scopri|prossimo|vai\s*avanti|ottieni|scopri\s*(la\s*)?(tua\s*)?(offerta|risultato)|next\s*step|go|vai|proceed|siguiente|siguir|weiter|suivant|continuer|próximo|continuar/i;

function isTrackingUrl(url: string): boolean {
  return TRACKING_PATTERNS.test(url);
}
function isCheckoutUrl(url: string): boolean {
  return CHECKOUT_PATTERNS.test(url);
}

async function getQuizContentFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main, [role="main"], .quiz-container, .quiz-content, [class*="quiz"], #quiz, .content, [class*="content"]') || document.body;
    const text = (main as HTMLElement).innerText?.slice(0, 5000) || '';
    const h1 = document.querySelector('h1')?.innerText || '';
    const h2 = document.querySelector('h2')?.innerText || '';
    const stepEl = document.querySelector('[data-step], [data-question], .step, .slide, [class*="step"]');
    const stepAttr = stepEl ? (stepEl.getAttribute('data-step') || stepEl.getAttribute('data-question') || stepEl.className) : '';
    const options = Array.from(document.querySelectorAll('[class*="option"], [class*="answer"], [class*="choice"], input[type="radio"]:checked, [aria-selected="true"]'))
      .map((el) => (el as HTMLElement).innerText?.slice(0, 100) || (el as HTMLInputElement).value || '').join('|');
    return `${h1}|${h2}|${stepAttr}|${text.length}|${options}|${text.slice(0, 800)}`;
  });
}

function isCheckoutLikePage(url: string, pageTitle?: string): boolean {
  const u = (url + ' ' + (pageTitle || '')).toLowerCase();
  return /checkout|carrello|cart|pagamento|payment|acquista|buy\s*now|ordine|order\s*summary|pay\s*now/i.test(u);
}

async function getQuizStepLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h1 = (document.querySelector('h1') as HTMLElement | null)?.innerText?.trim();
    const h2 = (document.querySelector('h2') as HTMLElement | null)?.innerText?.trim();
    const question = (document.querySelector('[class*="question"], [data-question], .quiz-question') as HTMLElement | null)?.innerText?.trim();
    return h1 || h2 || question || 'Quiz step';
  });
}

async function clickQuizAdvance(page: Page): Promise<boolean> {
  return page.evaluate((nextPattern: string) => {
    const pattern = new RegExp(nextPattern, 'i');
    const candidates: { el: HTMLElement; priority: number }[] = [];
    const els = document.querySelectorAll('button, [role="button"], input[type="submit"], a[class*="btn"], a[class*="button"], label[for], input[type="radio"]:not(:checked), [class*="option"]:not([aria-selected="true"]), [class*="answer"], [class*="choice"], [class*="cta"], [class*="next"]');
    els.forEach((el) => {
      const text = (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || '';
      if (!text || text.length > 200) return;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.visibility === 'hidden' || style.display === 'none') return;
      let priority = 0;
      if (pattern.test(text)) priority = 10;
      else if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') priority = 6;
      else if ((el as HTMLInputElement).type === 'radio') priority = 5;
      else if ((el as HTMLInputElement).type === 'submit') priority = 7;
      else if (/btn|button|cta|next|submit/i.test((el.className as string) || '')) priority = 4;
      else if (el.tagName === 'LABEL') priority = 3;
      else if (/option|answer|choice/i.test((el.className as string) || '')) priority = 2;
      else priority = 1;
      candidates.push({ el: el as HTMLElement, priority });
    });
    candidates.sort((a, b) => b.priority - a.priority);
    for (const { el } of candidates) {
      try {
        (el as HTMLElement).click();
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }, QUIZ_NEXT_PATTERNS.source);
}

export interface CrawlParams {
  entryUrl: string;
  headless?: boolean;
  maxSteps?: number;
  maxDepth?: number;
  followSameOriginOnly?: boolean;
  captureScreenshots?: boolean;
  captureNetwork?: boolean;
  captureCookies?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  quizMode?: boolean;
  quizMaxSteps?: number;
}

export async function runCrawl(jobId: string, params: CrawlParams): Promise<void> {
  const startTime = Date.now();
  let browser: Browser | null = null;
  const entryUrl = params.entryUrl;
  const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxDepth = params.maxDepth ?? 3;
  const followSameOriginOnly = params.followSameOriginOnly ?? true;
  const captureScreenshots = params.captureScreenshots ?? true;
  const captureNetwork = params.captureNetwork ?? true;
  const captureCookies = params.captureCookies ?? true;
  const viewportWidth = params.viewportWidth ?? 1280;
  const viewportHeight = params.viewportHeight ?? 720;
  const quizMode = params.quizMode ?? false;
  const quizMaxSteps = params.quizMaxSteps ?? QUIZ_MAX_STEPS;

  try {
    updateJob(jobId, { status: 'running', currentStep: 0, totalSteps: maxSteps });

    const normalizedEntry = new URL(entryUrl).origin + new URL(entryUrl).pathname;
    const visited = new Set<string>();
    const steps: FunnelCrawlStep[] = [];
    const queue: { url: string; depth: number }[] = [{ url: normalizedEntry, depth: 0 }];

    browser = await launchBrowser({ headless: params.headless ?? true });

    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });

    const networkRequests: FunnelCrawlNetworkRequest[] = [];
    if (captureNetwork) {
      context.on('request', (req) => {
        const u = req.url();
        networkRequests.push({
          url: u,
          method: req.method(),
          resourceType: req.resourceType(),
          isTracking: isTrackingUrl(u),
          isCheckout: isCheckoutUrl(u),
        });
      });
      context.on('response', (res) => {
        const req = res.request();
        const idx = networkRequests.findIndex((r) => r.url === req.url() && r.method === req.method());
        if (idx !== -1) networkRequests[idx].status = res.status();
      });
    }

    // ---- Quiz mode ----
    if (quizMode) {
      let quizPage: Page | null = null;
      try {
        quizPage = await context.newPage();
        quizPage.setDefaultTimeout(NAV_TIMEOUT_MS);
        const response = await quizPage.goto(normalizedEntry, {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        });
        if (!response) {
          await quizPage.close();
          updateJob(jobId, {
            status: 'failed',
            error: 'Failed to load quiz page',
          });
          return;
        }
        await quizPage.waitForLoadState('networkidle').catch(() => {});

        const seenFingerprints = new Set<string>();
        let consecutiveSameFingerprint = 0;
        const maxQuizSteps = Math.min(quizMaxSteps, 35);

        const captureQuizStep = async (): Promise<FunnelCrawlStep> => {
          if (!quizPage) throw new Error('Page closed');
          networkRequests.length = 0;
          const title = await quizPage.title();
          const quizLabel = await getQuizStepLabel(quizPage);
          let screenshotBase64: string | undefined;
          if (captureScreenshots) {
            try {
              const buf = await quizPage.screenshot({ fullPage: true, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
              screenshotBase64 = buf.toString('base64');
            } catch {
              // step without screenshot if timeout (slow fonts/resources)
            }
          }
          const allLinks = await quizPage.$$eval('a[href]', (anchors) =>
            anchors.map((a) => ({
              href: (a as HTMLAnchorElement).href,
              text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 200) || '',
            }))
          );
          const links: FunnelCrawlLink[] = [];
          const ctaButtons: FunnelCrawlLink[] = [];
          for (const { href, text } of allLinks) {
            try {
              const full = new URL(href, quizPage!.url()).href;
              const isCta = !!(/btn|button|cta|submit|buy|order|get|start|claim/i.test(text || '') || (text && text.length < 50));
              links.push({ href: full, text: text || '', isCta });
              if (isCta) ctaButtons.push({ href: full, text: text || '', isCta: true });
            } catch {
              /* skip */
            }
          }
          const forms: FunnelCrawlForm[] = await quizPage.$$eval('form[action]', (formsEl) =>
            formsEl.map((f) => {
              const form = f as HTMLFormElement;
              const action = form.action || '';
              const method = (form.method || 'get').toLowerCase();
              const inputs = Array.from(form.querySelectorAll('input, select, textarea'))
                .filter((el) => (el as HTMLInputElement).name)
                .map((el) => {
                  const input = el as HTMLInputElement;
                  return { name: input.name, type: (input.type || 'text').toLowerCase(), required: input.required ?? false };
                });
              const submit = form.querySelector('button[type="submit"], input[type="submit"]');
              return { action, method, inputs, submitButtonText: submit ? (submit as HTMLElement).textContent?.trim()?.slice(0, 100) : undefined };
            })
          );
          let cookies: FunnelCrawlCookie[] = [];
          if (captureCookies) {
            const cks = await context.cookies();
            cookies = cks.map((c) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure }));
          }
          const domLength = captureNetwork ? await quizPage.evaluate(() => document.documentElement.outerHTML.length) : 0;
          return {
            stepIndex: steps.length + 1,
            url: quizPage.url(),
            title: quizLabel || title,
            screenshotBase64,
            links: [...links],
            ctaButtons: [...ctaButtons],
            forms: [...forms],
            networkRequests: captureNetwork ? [...networkRequests] : [],
            cookies,
            domLength,
            timestamp: new Date().toISOString(),
            isQuizStep: true,
            quizStepLabel: quizLabel || undefined,
          };
        };

        while (steps.length < maxQuizSteps) {
          const fingerprint = await getQuizContentFingerprint(quizPage);
          seenFingerprints.add(fingerprint);

          const step = await captureQuizStep();
          steps.push(step);
          updateJob(jobId, { currentStep: steps.length, totalSteps: maxQuizSteps });

          if (isCheckoutLikePage(quizPage.url(), step.title)) break;

          const clicked = await clickQuizAdvance(quizPage);
          if (!clicked) break;
          consecutiveSameFingerprint = 0;

          await new Promise((r) => setTimeout(r, QUIZ_STEP_WAIT_MS));
          const newFingerprint = await getQuizContentFingerprint(quizPage);
          if (newFingerprint === fingerprint) {
            await new Promise((r) => setTimeout(r, QUIZ_TRANSITION_MS));
            const retryFingerprint = await getQuizContentFingerprint(quizPage);
            if (retryFingerprint === fingerprint) {
              consecutiveSameFingerprint++;
              if (consecutiveSameFingerprint >= QUIZ_SAME_FINGERPRINT_MAX) break;
            } else {
              consecutiveSameFingerprint = 0;
            }
          } else {
            consecutiveSameFingerprint = 0;
          }
        }

        const result: FunnelCrawlResult = {
          success: true,
          entryUrl,
          steps,
          totalSteps: steps.length,
          durationMs: Date.now() - startTime,
          visitedUrls: [normalizedEntry],
          isQuizFunnel: true,
        };
        await quizPage.close();
        updateJob(jobId, { status: 'completed', result, currentStep: steps.length, totalSteps: steps.length });
      } catch (err) {
        console.error('Quiz crawl error:', err);
        await quizPage?.close().catch(() => {});
        updateJob(jobId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Error during quiz crawl',
          result: { success: false, entryUrl, steps, totalSteps: steps.length, durationMs: Date.now() - startTime, visitedUrls: [normalizedEntry], isQuizFunnel: true },
        });
      }
      return;
    }

    // ---- Standard BFS crawl ----
    const entryOrigin = new URL(entryUrl).origin;
    while (queue.length > 0 && steps.length < maxSteps) {
      const { url: currentUrl, depth } = queue.shift()!;
      if (visited.has(currentUrl) || depth > maxDepth) continue;
      visited.add(currentUrl);

      updateJob(jobId, { currentStep: steps.length + 1, totalSteps: maxSteps });
      networkRequests.length = 0;

      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      try {
        const response = await page.goto(currentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        });
        if (!response) {
          await page.close();
          continue;
        }
        const finalUrl = page.url();
        if (followSameOriginOnly) {
          try {
            const currentOrigin = new URL(finalUrl).origin;
            if (currentOrigin !== entryOrigin) {
              await page.close();
              continue;
            }
          } catch {
            await page.close();
            continue;
          }
        }

        await page.waitForLoadState('networkidle').catch(() => {});

        const title = await page.title();
        let screenshotBase64: string | undefined;
        if (captureScreenshots) {
          try {
            const buf = await page.screenshot({ fullPage: true, type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
            screenshotBase64 = buf.toString('base64');
          } catch {
            // step without screenshot if timeout
          }
        }

        const allLinks = await page.$$eval('a[href]', (anchors) =>
          anchors.map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 200) || '',
          }))
        );
        const links: FunnelCrawlLink[] = [];
        const ctaButtons: FunnelCrawlLink[] = [];
        for (const { href, text } of allLinks) {
          try {
            const full = new URL(href, currentUrl).href;
            const isCta = !!(/btn|button|cta|submit|buy|order|get|start|join|sign|claim/i.test(text || '') || (text && text.length < 50));
            links.push({ href: full, text: text || '', isCta });
            if (isCta) ctaButtons.push({ href: full, text: text || '', isCta: true });
          } catch {
            /* skip */
          }
        }

        const forms: FunnelCrawlForm[] = await page.$$eval('form[action]', (formsEl) =>
          formsEl.map((f) => {
            const form = f as HTMLFormElement;
            const action = form.action || '';
            const method = (form.method || 'get').toLowerCase();
            const inputs = Array.from(form.querySelectorAll('input, select, textarea'))
              .filter((el) => (el as HTMLInputElement).name)
              .map((el) => {
                const input = el as HTMLInputElement;
                return { name: input.name, type: (input.type || 'text').toLowerCase(), required: input.required ?? false };
              });
            const submit = form.querySelector('button[type="submit"], input[type="submit"]');
            return { action, method, inputs, submitButtonText: submit ? (submit as HTMLElement).textContent?.trim()?.slice(0, 100) : undefined };
          })
        );

        let cookies: FunnelCrawlCookie[] = [];
        if (captureCookies) {
          const cks = await context.cookies();
          cookies = cks.map((c) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure }));
        }

        const domLength = captureNetwork ? await page.evaluate(() => document.documentElement.outerHTML.length) : 0;

        let contentText: string | undefined;
        if (maxSteps === 1) {
          contentText = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 100_000));
        }

        steps.push({
          stepIndex: steps.length + 1,
          url: finalUrl,
          title,
          screenshotBase64,
          links: [...links],
          ctaButtons: [...ctaButtons],
          forms: [...forms],
          networkRequests: captureNetwork ? [...networkRequests] : [],
          cookies,
          domLength,
          timestamp: new Date().toISOString(),
          ...(contentText !== undefined && { contentText }),
        });

        if (depth < maxDepth && followSameOriginOnly) {
          for (const link of links) {
            try {
              const full = new URL(link.href);
              if (full.origin === entryOrigin && full.href !== finalUrl && !visited.has(full.href)) {
                const pathQuery = full.origin + full.pathname + full.search;
                queue.push({ url: pathQuery, depth: depth + 1 });
              }
            } catch {
              /* skip */
            }
          }
        }
      } catch (err) {
        console.error('Crawl step error:', currentUrl, err);
      } finally {
        await page.close();
      }
    }

    const result: FunnelCrawlResult = {
      success: true,
      entryUrl,
      steps,
      totalSteps: steps.length,
      durationMs: Date.now() - startTime,
      visitedUrls: Array.from(visited),
    };
    updateJob(jobId, { status: 'completed', result, currentStep: steps.length, totalSteps: steps.length });
  } catch (error) {
    console.error('Crawl runner error:', error);
    updateJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    if (browser) await browser.close();
  }
}
