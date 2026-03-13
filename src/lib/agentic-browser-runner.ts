/**
 * Agentic Browser — Gemini Computer Use + Playwright.
 *
 * Agent loop:
 * 1. Navigate to the entry URL
 * 2. Screenshot → Gemini Computer Use → actions (click, type, scroll, etc.)
 * 3. Playwright executes actions with denormalized coordinates
 * 4. Screenshot → send as function_response → repeat
 * 5. Until checkout / end of funnel / max step
 *
 * The Computer Use model "sees" the screen and generates coordinate-based actions,
 * solving text-matching and quiz selection issues.
 */
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from '@/lib/get-browser';
import type { AgenticCrawlResult, AgenticCrawlStep, ComputerUseAction } from '@/types';
import { updateAgenticJob } from './agentic-job-store';
import {
  type CUContent,
  type CUAction,
  callComputerUse,
  buildInitialContent,
  buildFunctionResponseContent,
  trimConversationHistory,
  denormalizeX,
  denormalizeY,
  RECOMMENDED_SCREEN_WIDTH,
  RECOMMENDED_SCREEN_HEIGHT,
} from './gemini-computer-use';

// =====================================================
// CONSTANTS
// =====================================================

const NAV_TIMEOUT_MS = 90_000;
const ACTION_SETTLE_MS = 2000;
const SCREENSHOT_QUALITY = 80; // JPEG quality
const MAX_SCREENSHOTS_IN_HISTORY = 15;

// =====================================================
// STANDARDIZED FUNNEL NAVIGATION PROMPT
// =====================================================

const FUNNEL_NAVIGATION_PROMPT = `You are a marketing funnel analyst agent. Your task is to navigate through this marketing/sales funnel from the entry landing page all the way to the checkout or payment page.

NAVIGATION STRATEGY:
1. On each page, identify the PRIMARY call-to-action (CTA) that advances the user through the funnel
2. Click the main CTA button to progress (e.g. "Buy Now", "Add to Cart", "Continue", "Next", "Get Started", "Take Quiz", "See Results", "Claim Offer", "Order Now", "Checkout", "Submit", "Sign Up")
3. For QUIZ or SURVEY funnels: you MUST select an answer option FIRST (click on a quiz answer card/radio button/option), THEN click the "Continue" / "Next" / "Submit" button to advance
4. For forms that require input: fill with realistic test data (name: John Smith, email: test@example.com, phone: 555-0100, zip: 90210)
5. Dismiss cookie banners, notification popups, consent dialogs, and age verification gates by clicking accept/agree/close
6. If a page has multiple CTAs, choose the one most likely to lead toward purchase/checkout
7. If you see a video or timer, don't wait — click the CTA beneath it
8. Scroll down if you don't see a clear CTA — many landing pages have CTAs below the fold

STOP CONDITIONS — stop navigating when:
- You have reached a CHECKOUT or PAYMENT page (with payment form, credit card fields, order summary)
- You have reached an ORDER CONFIRMATION or THANK YOU page
- You cannot find any forward-progressing CTA after scrolling
- The page requires REAL payment information or login credentials
- You are redirected to an external domain unrelated to the funnel

DO NOT:
- Click navigation menu items, footer links, or backward-navigation buttons
- Enter real payment or credit card information
- Click on social media links, share buttons, or external resources
- Get stuck clicking the same button repeatedly — if a click doesn't change the page, try a different approach (scroll, click another element)

IMPORTANT: Report what you observe on each page. When the funnel is complete or you can't progress further, explain why you stopped.`;

// =====================================================
// LOGGING
// =====================================================

function log(jobId: string, ...args: unknown[]) {
  console.log(`[computer-use:${jobId.slice(0, 8)}]`, ...args);
}

// =====================================================
// PARAMS & ENTRY POINT
// =====================================================

export interface AgenticCrawlParams {
  entryUrl: string;
  maxSteps?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export async function runAgenticCrawl(
  jobId: string,
  params: AgenticCrawlParams,
): Promise<void> {
  const startTime = Date.now();
  let browser: Browser | null = null;
  const entryUrl = params.entryUrl;
  const maxSteps = params.maxSteps ?? 100;
  const screenWidth = params.viewportWidth ?? RECOMMENDED_SCREEN_WIDTH;
  const screenHeight = params.viewportHeight ?? RECOMMENDED_SCREEN_HEIGHT;

  const apiKey = (
    (process.env.GEMINI_API_KEY ?? '') ||
    (process.env.GOOGLE_GEMINI_API_KEY ?? '')
  ).trim();
  if (!apiKey) {
    updateAgenticJob(jobId, {
      status: 'failed',
      error: 'Missing GEMINI_API_KEY',
    });
    return;
  }

  const steps: AgenticCrawlStep[] = [];
  let stopReason = '';

  try {
    updateAgenticJob(jobId, { status: 'running', currentStep: 0, totalSteps: maxSteps });
    log(jobId, 'Starting Computer Use crawl:', entryUrl, '| maxSteps:', maxSteps);

    // ----- Launch browser -----
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: screenWidth, height: screenHeight },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // ----- Navigate to entry URL -----
    log(jobId, 'Navigating to:', entryUrl);
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle').catch(() => {});
    log(jobId, 'Page loaded:', page.url());

    // ----- Initial screenshot -----
    const initialScreenshot = await takeScreenshot(page);
    log(jobId, 'Initial screenshot taken');

    // Save step 0 (entry page)
    steps.push({
      stepIndex: 1,
      url: page.url(),
      title: await page.title(),
      screenshotBase64: initialScreenshot,
      timestamp: new Date().toISOString(),
    });
    publishPartialResult(jobId, entryUrl, steps, startTime, maxSteps);

    // ----- Initialize conversation history -----
    const contents: CUContent[] = [
      buildInitialContent(FUNNEL_NAVIGATION_PROMPT, initialScreenshot),
    ];

    // ----- Agent Loop -----
    let noActionCount = 0;

    for (let turn = 0; turn < maxSteps; turn++) {
      const turnNum = turn + 1;
      log(jobId, `--- Turn ${turnNum} ---`);
      updateAgenticJob(jobId, { currentStep: steps.length, totalSteps: maxSteps });

      // 1. Call Gemini Computer Use
      log(jobId, 'Calling Gemini Computer Use...');
      let response;
      try {
        response = await callComputerUse(apiKey, contents);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(jobId, 'Gemini API error:', errMsg);
        stopReason = 'gemini_api_error';
        break;
      }

      // 2. Append model response to history
      contents.push(response.modelContent);

      if (response.text) {
        log(jobId, 'Model thought:', response.text.slice(0, 300));
      }

      // 3. Check if task is complete (model returned text only, no actions)
      if (response.isTaskComplete) {
        log(jobId, 'Model says task complete:', response.text?.slice(0, 200));
        stopReason = 'task_complete';
        // Save a final step with the model's conclusion
        steps[steps.length - 1].modelThought = response.text;
        publishPartialResult(jobId, entryUrl, steps, startTime, maxSteps);
        break;
      }

      // 4. No actions returned
      if (response.actions.length === 0) {
        noActionCount++;
        log(jobId, `No actions (count: ${noActionCount})`);
        if (noActionCount >= 3) {
          stopReason = 'no_actions_repeated';
          break;
        }
        continue;
      }
      noActionCount = 0;

      // 5. Execute actions
      log(jobId, `Executing ${response.actions.length} action(s):`);
      const execResults: { actionName: string; error?: string; safetyAcknowledged?: boolean }[] = [];
      const executedActions: ComputerUseAction[] = [];
      let actionError: string | undefined;

      for (const action of response.actions) {
        log(jobId, `  -> ${action.name}`, JSON.stringify(action.args));

        // Handle safety decisions
        let safetyAcknowledged = false;
        if (action.safetyDecision?.decision === 'require_confirmation') {
          // Auto-confirm safe actions (cookie banners, etc.)
          // Block financial transactions
          const explanation = (action.safetyDecision.explanation || '').toLowerCase();
          if (
            explanation.includes('payment') ||
            explanation.includes('purchase') ||
            explanation.includes('credit card') ||
            explanation.includes('billing')
          ) {
            log(jobId, '  BLOCKED: payment/financial action');
            execResults.push({ actionName: action.name, error: 'blocked_financial_action' });
            stopReason = 'blocked_payment_action';
            break;
          }
          log(jobId, '  Auto-confirming safety decision:', action.safetyDecision.explanation?.slice(0, 100));
          safetyAcknowledged = true;
        }

        // Execute the action
        try {
          await executeAction(page, action, screenWidth, screenHeight);
          execResults.push({ actionName: action.name, safetyAcknowledged });
          executedActions.push({ name: action.name, args: action.args });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(jobId, `  Error executing ${action.name}:`, errMsg);
          execResults.push({ actionName: action.name, error: errMsg, safetyAcknowledged });
          actionError = errMsg;
        }
      }

      if (stopReason === 'blocked_payment_action') break;

      // 6. Wait for page to settle after actions
      try {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
          page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}),
          new Promise((r) => setTimeout(r, ACTION_SETTLE_MS)),
        ]);
        await page.waitForTimeout(800);
      } catch {
        // Timeout OK
      }

      // 7. Capture new screenshot
      const screenshot = await takeScreenshot(page);
      const currentUrl = page.url();
      const currentTitle = await page.title();
      log(jobId, 'URL after actions:', currentUrl, '| Title:', currentTitle);

      // 8. Build function response and add to history
      const frContent = buildFunctionResponseContent(
        execResults,
        currentUrl,
        screenshot,
      );
      contents.push(frContent);

      // 9. Save step
      steps.push({
        stepIndex: steps.length + 1,
        url: currentUrl,
        title: currentTitle,
        screenshotBase64: screenshot,
        actions: executedActions,
        modelThought: response.text,
        actionExecuted: !actionError,
        actionError,
        timestamp: new Date().toISOString(),
      });
      publishPartialResult(jobId, entryUrl, steps, startTime, maxSteps);

      // 10. Check stop conditions
      if (isCheckoutPage(currentUrl, currentTitle)) {
        log(jobId, 'Checkout page detected');
        stopReason = 'checkout_reached';
        break;
      }

      // 11. Trim conversation history (sliding window)
      trimConversationHistory(contents, MAX_SCREENSHOTS_IN_HISTORY);
    }

    if (!stopReason && steps.length >= maxSteps) {
      stopReason = 'max_steps_reached';
    }
    if (!stopReason) stopReason = 'loop_ended';

    log(jobId, 'Crawl finished. Steps:', steps.length, '| Reason:', stopReason);

    const result: AgenticCrawlResult = {
      success: true,
      entryUrl,
      steps,
      totalSteps: steps.length,
      durationMs: Date.now() - startTime,
      stopReason,
    };
    updateAgenticJob(jobId, {
      status: 'completed',
      result,
      currentStep: steps.length,
      totalSteps: steps.length,
    });
  } catch (error) {
    console.error('[computer-use] Fatal error:', error);
    updateAgenticJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      result: {
        success: false,
        entryUrl,
        steps,
        totalSteps: steps.length,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Error',
        stopReason: 'exception',
      },
    });
  } finally {
    await browser?.close();
  }
}

// =====================================================
// ACTION EXECUTOR
// =====================================================

/**
 * Executes a single Computer Use action on Playwright.
 * Coordinates are normalized (0-999) and are denormalized
 * to actual screen dimensions.
 */
async function executeAction(
  page: Page,
  action: CUAction,
  screenWidth: number,
  screenHeight: number,
): Promise<void> {
  const { name, args } = action;

  switch (name) {
    case 'open_web_browser':
      // Browser already open
      break;

    case 'navigate': {
      const url = args.url as string;
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForLoadState('networkidle').catch(() => {});
      }
      break;
    }

    case 'click_at': {
      const x = denormalizeX(args.x as number, screenWidth);
      const y = denormalizeY(args.y as number, screenHeight);
      await page.mouse.click(x, y);
      break;
    }

    case 'type_text_at': {
      const x = denormalizeX(args.x as number, screenWidth);
      const y = denormalizeY(args.y as number, screenHeight);
      const text = args.text as string;
      const pressEnter = args.press_enter as boolean ?? true;
      const clearBefore = args.clear_before_typing as boolean ?? true;

      // Click to focus
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);

      if (clearBefore) {
        // Select all + delete (cross-platform)
        await page.keyboard.press('Meta+A').catch(() =>
          page.keyboard.press('Control+A')
        );
        await page.keyboard.press('Backspace');
      }

      await page.keyboard.type(text, { delay: 30 });

      if (pressEnter) {
        await page.keyboard.press('Enter');
      }
      break;
    }

    case 'hover_at': {
      const x = denormalizeX(args.x as number, screenWidth);
      const y = denormalizeY(args.y as number, screenHeight);
      await page.mouse.move(x, y);
      break;
    }

    case 'scroll_document': {
      const direction = args.direction as string;
      const scrollAmount = 400;
      switch (direction) {
        case 'up':
          await page.mouse.wheel(0, -scrollAmount);
          break;
        case 'down':
          await page.mouse.wheel(0, scrollAmount);
          break;
        case 'left':
          await page.mouse.wheel(-scrollAmount, 0);
          break;
        case 'right':
          await page.mouse.wheel(scrollAmount, 0);
          break;
      }
      break;
    }

    case 'scroll_at': {
      const x = denormalizeX(args.x as number, screenWidth);
      const y = denormalizeY(args.y as number, screenHeight);
      const direction = args.direction as string;
      const magnitude = args.magnitude as number ?? 800;
      const scrollPx = Math.round((magnitude / 1000) * screenHeight);

      // Move to position first
      await page.mouse.move(x, y);

      switch (direction) {
        case 'up':
          await page.mouse.wheel(0, -scrollPx);
          break;
        case 'down':
          await page.mouse.wheel(0, scrollPx);
          break;
        case 'left':
          await page.mouse.wheel(-scrollPx, 0);
          break;
        case 'right':
          await page.mouse.wheel(scrollPx, 0);
          break;
      }
      break;
    }

    case 'key_combination': {
      const keys = args.keys as string;
      if (keys) {
        // Playwright uses '+' for key combinations (e.g. "Control+C")
        await page.keyboard.press(keys);
      }
      break;
    }

    case 'go_back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      break;

    case 'go_forward':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      break;

    case 'search':
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });
      break;

    case 'wait_5_seconds':
      await page.waitForTimeout(5000);
      break;

    case 'drag_and_drop': {
      const fromX = denormalizeX(args.x as number, screenWidth);
      const fromY = denormalizeY(args.y as number, screenHeight);
      const toX = denormalizeX(args.destination_x as number, screenWidth);
      const toY = denormalizeY(args.destination_y as number, screenHeight);

      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(toX, toY, { steps: 10 });
      await page.mouse.up();
      break;
    }

    default:
      console.warn(`[computer-use] Unimplemented action: ${name}`);
  }

  // Small wait after any action for rendering
  await page.waitForTimeout(300);
}

// =====================================================
// HELPERS
// =====================================================

async function takeScreenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({
    type: 'jpeg',
    quality: SCREENSHOT_QUALITY,
    timeout: 30_000,
  });
  return buf.toString('base64');
}

function isCheckoutPage(url: string, title?: string): boolean {
  const text = (url + ' ' + (title || '')).toLowerCase();
  return /checkout|cart|carrello|pagamento|payment|order[\s_-]*summary|pay[\s_-]*now|billing/i.test(text);
}

function publishPartialResult(
  jobId: string,
  entryUrl: string,
  steps: AgenticCrawlStep[],
  startTime: number,
  maxSteps: number,
): void {
  updateAgenticJob(jobId, {
    currentStep: steps.length,
    totalSteps: maxSteps,
    result: {
      success: true,
      entryUrl,
      steps: [...steps],
      totalSteps: steps.length,
      durationMs: Date.now() - startTime,
    },
  });
}
