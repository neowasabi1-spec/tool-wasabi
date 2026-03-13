/**
 * Browser automation engine for deploying HTML funnel pages
 * to Funnelish and Checkout Champ via Playwright.
 *
 * Neither platform offers a page-creation API, so we automate the UI.
 */

import { launchBrowser, type Browser, type Page } from './get-browser';

export type DeployPlatform = 'checkout_champ' | 'funnelish';

export type DeployStatus =
  | 'pending'
  | 'logging_in'
  | 'creating_funnel'
  | 'uploading_html'
  | 'configuring'
  | 'publishing'
  | 'completed'
  | 'failed';

export interface DeployResult {
  success: boolean;
  platform: DeployPlatform;
  status: DeployStatus;
  funnelUrl?: string;
  previewUrl?: string;
  screenshotBase64?: string;
  steps: DeployStepLog[];
  error?: string;
  durationMs: number;
}

export interface DeployStepLog {
  step: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  timestamp: string;
  screenshotBase64?: string;
}

export interface DeployOptions {
  platform: DeployPlatform;
  html: string;
  funnelName: string;
  pageName?: string;
  pageType?: string;
  credentials: PlatformCredentials;
  /** Inject tracking scripts (Checkout Champ) */
  trackingSnippet?: string;
  headless?: boolean;
}

export interface PlatformCredentials {
  email: string;
  password: string;
  /** Checkout Champ CRM subdomain, e.g. "mystore" → mystore.checkoutchamp.com */
  subdomain?: string;
}

function log(steps: DeployStepLog[], step: string, status: DeployStepLog['status'], message: string, screenshot?: string) {
  steps.push({
    step,
    status,
    message,
    timestamp: new Date().toISOString(),
    screenshotBase64: screenshot,
  });
}

async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
  return buf.toString('base64');
}

async function waitAndClick(page: Page, selector: string, timeout = 10_000) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

/* ════════════════════════════════════════════════════════
   CHECKOUT CHAMP — HTML Import via Funnel Builder UI
   ════════════════════════════════════════════════════════ */

async function deployToCheckoutChamp(
  page: Page,
  opts: DeployOptions,
  steps: DeployStepLog[],
): Promise<Partial<DeployResult>> {
  const subdomain = opts.credentials.subdomain || 'app';
  const loginUrl = `https://${subdomain}.checkoutchamp.com`;

  // 1. Login
  log(steps, 'login', 'ok', `Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2000);

  const loginInput = await page.$('input[name="email"], input[type="email"], #email, #username');
  if (loginInput) {
    await loginInput.fill(opts.credentials.email);
    const pwInput = await page.$('input[name="password"], input[type="password"], #password');
    if (pwInput) await pwInput.fill(opts.credentials.password);

    const loginBtn = await page.$('button[type="submit"], input[type="submit"], .login-btn, #loginBtn');
    if (loginBtn) await loginBtn.click();
    await page.waitForTimeout(5000);
    log(steps, 'login', 'ok', 'Login submitted', await screenshot(page));
  } else {
    log(steps, 'login', 'warn', 'Login form not found — may already be logged in');
  }

  // 2. Navigate to Funnel Builder
  log(steps, 'navigate', 'ok', 'Navigating to Funnel Builder');
  await page.goto(`${loginUrl}/funnels`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(3000);

  // 3. Create new funnel
  log(steps, 'create_funnel', 'ok', `Creating funnel: ${opts.funnelName}`);
  const createBtn = await page.$('[class*="create"], [class*="new"], button:has-text("Create"), button:has-text("New"), a:has-text("Create")');
  if (createBtn) {
    await createBtn.click();
    await page.waitForTimeout(3000);

    const nameInput = await page.$('input[name="name"], input[name="funnelName"], input[placeholder*="name"], input[placeholder*="Name"]');
    if (nameInput) {
      await nameInput.fill(opts.funnelName);
    }

    const saveBtn = await page.$('button:has-text("Save"), button:has-text("Create"), button[type="submit"]');
    if (saveBtn) {
      await saveBtn.click();
      await page.waitForTimeout(3000);
    }
    log(steps, 'create_funnel', 'ok', 'Funnel created', await screenshot(page));
  } else {
    log(steps, 'create_funnel', 'warn', 'Create button not found — attempting direct page creation');
  }

  // 4. Navigate to page builder / HTML upload
  log(steps, 'upload_html', 'ok', 'Looking for HTML upload option');

  const settingsLink = await page.$('a:has-text("Settings"), [class*="settings"]');
  if (settingsLink) {
    await settingsLink.click();
    await page.waitForTimeout(2000);
  }

  const maintenanceLink = await page.$('a:has-text("Maintenance"), [class*="maintenance"]');
  if (maintenanceLink) {
    await maintenanceLink.click();
    await page.waitForTimeout(2000);
  }

  const fileUploadLink = await page.$('a:has-text("File Upload"), [class*="file-upload"], button:has-text("Upload")');
  if (fileUploadLink) {
    await fileUploadLink.click();
    await page.waitForTimeout(2000);
  }

  // 5. Upload HTML by injecting into code editor or textarea
  let htmlToUpload = opts.html;
  if (opts.trackingSnippet) {
    htmlToUpload = htmlToUpload.replace('</body>', `${opts.trackingSnippet}\n</body>`);
  }

  const codeEditor = await page.$('textarea, [contenteditable="true"], .CodeMirror, .ace_editor, [class*="code-editor"]');
  if (codeEditor) {
    const tagName = await codeEditor.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'textarea') {
      await codeEditor.fill(htmlToUpload);
    } else {
      await page.evaluate((html) => {
        const cm = document.querySelector('.CodeMirror') as HTMLElement & { CodeMirror?: { setValue: (v: string) => void } };
        if (cm?.CodeMirror) {
          cm.CodeMirror.setValue(html);
        } else {
          const editable = document.querySelector('[contenteditable="true"]');
          if (editable) editable.innerHTML = html;
        }
      }, htmlToUpload);
    }
    log(steps, 'upload_html', 'ok', `HTML injected (${htmlToUpload.length} chars)`, await screenshot(page));
  } else {
    // Fallback: try page builder's custom HTML block
    const htmlBlockBtn = await page.$('button:has-text("HTML"), [class*="html-block"], [data-type="html"]');
    if (htmlBlockBtn) {
      await htmlBlockBtn.click();
      await page.waitForTimeout(2000);
      const htmlTextarea = await page.$('textarea');
      if (htmlTextarea) {
        await htmlTextarea.fill(htmlToUpload);
      }
      log(steps, 'upload_html', 'ok', 'HTML inserted via HTML block');
    } else {
      log(steps, 'upload_html', 'error', 'Could not find HTML input area');
      return { success: false, status: 'failed', error: 'HTML input area not found in Checkout Champ UI' };
    }
  }

  // 6. Save / Publish
  log(steps, 'publish', 'ok', 'Saving and publishing');
  const publishBtn = await page.$('button:has-text("Publish"), button:has-text("Save"), button:has-text("Salva")');
  if (publishBtn) {
    await publishBtn.click();
    await page.waitForTimeout(5000);
    log(steps, 'publish', 'ok', 'Published successfully', await screenshot(page));
  }

  const currentUrl = page.url();
  return {
    success: true,
    status: 'completed',
    funnelUrl: currentUrl,
    previewUrl: currentUrl,
  };
}

/* ════════════════════════════════════════════════════════
   FUNNELISH — HTML Import via Custom HTML Element
   ════════════════════════════════════════════════════════ */

async function deployToFunnelish(
  page: Page,
  opts: DeployOptions,
  steps: DeployStepLog[],
): Promise<Partial<DeployResult>> {
  const loginUrl = 'https://app.funnelish.com/login';

  // 1. Login
  log(steps, 'login', 'ok', `Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2000);

  const emailInput = await page.$('input[name="email"], input[type="email"], #email');
  if (emailInput) {
    await emailInput.fill(opts.credentials.email);
    const pwInput = await page.$('input[name="password"], input[type="password"], #password');
    if (pwInput) await pwInput.fill(opts.credentials.password);

    const loginBtn = await page.$('button[type="submit"], input[type="submit"], .btn-login, button:has-text("Login"), button:has-text("Sign in")');
    if (loginBtn) await loginBtn.click();
    await page.waitForTimeout(5000);
    log(steps, 'login', 'ok', 'Login submitted', await screenshot(page));
  } else {
    log(steps, 'login', 'warn', 'Login form not found — may already be logged in');
  }

  // 2. Navigate to Funnels dashboard
  log(steps, 'navigate', 'ok', 'Navigating to funnels dashboard');
  await page.goto('https://app.funnelish.com/funnels', { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(3000);

  // 3. Create new funnel
  log(steps, 'create_funnel', 'ok', `Creating funnel: ${opts.funnelName}`);
  const newFunnelBtn = await page.$('button:has-text("Create"), button:has-text("New"), a:has-text("Create new funnel"), [class*="create"]');
  if (newFunnelBtn) {
    await newFunnelBtn.click();
    await page.waitForTimeout(3000);

    // Choose "Start from scratch" if option appears
    const scratchBtn = await page.$('button:has-text("Start from scratch"), button:has-text("Blank"), [class*="scratch"], [class*="blank"]');
    if (scratchBtn) {
      await scratchBtn.click();
      await page.waitForTimeout(2000);
    }

    // Enter funnel name
    const nameInput = await page.$('input[name="name"], input[placeholder*="name"], input[placeholder*="Name"], input[placeholder*="funnel"]');
    if (nameInput) {
      await nameInput.fill(opts.funnelName);
    }

    const confirmBtn = await page.$('button:has-text("Create"), button:has-text("Save"), button[type="submit"]');
    if (confirmBtn) {
      await confirmBtn.click();
      await page.waitForTimeout(4000);
    }
    log(steps, 'create_funnel', 'ok', 'Funnel created', await screenshot(page));
  } else {
    log(steps, 'create_funnel', 'warn', 'Create funnel button not found');
  }

  // 4. Add a new step/page
  log(steps, 'add_page', 'ok', 'Adding funnel step');
  const addStepBtn = await page.$('button:has-text("Add Step"), button:has-text("Add Page"), [class*="add-step"], a:has-text("Add")');
  if (addStepBtn) {
    await addStepBtn.click();
    await page.waitForTimeout(3000);

    const stepType = opts.pageType || 'landing';
    const typeBtn = await page.$(`button:has-text("${stepType}"), [data-type="${stepType}"], a:has-text("${stepType}")`);
    if (typeBtn) {
      await typeBtn.click();
      await page.waitForTimeout(2000);
    }

    const blankTemplate = await page.$('button:has-text("Blank"), [class*="blank"], [class*="empty"]');
    if (blankTemplate) {
      await blankTemplate.click();
      await page.waitForTimeout(3000);
    }
    log(steps, 'add_page', 'ok', 'Step added', await screenshot(page));
  }

  // 5. Open page editor
  log(steps, 'open_editor', 'ok', 'Opening page editor');
  const editBtn = await page.$('button:has-text("Edit"), a:has-text("Edit"), [class*="edit-page"], .pencil-icon, svg[class*="edit"]');
  if (editBtn) {
    await editBtn.click();
    await page.waitForTimeout(5000);
    log(steps, 'open_editor', 'ok', 'Editor opened', await screenshot(page));
  }

  // 6. Access "Custom Codes" or add Custom HTML element
  log(steps, 'inject_html', 'ok', 'Looking for Custom Codes / Custom HTML');

  // Method A: "More actions" → "Custom codes"
  const moreActions = await page.$('[class*="more-actions"], button:has-text("More"), [class*="toolbar-more"]');
  if (moreActions) {
    await moreActions.click();
    await page.waitForTimeout(1500);
    const customCodesBtn = await page.$('button:has-text("Custom codes"), a:has-text("Custom codes"), [class*="custom-code"]');
    if (customCodesBtn) {
      await customCodesBtn.click();
      await page.waitForTimeout(2000);

      // Paste HTML in body code section
      const bodyCodeArea = await page.$('textarea[name*="body"], textarea[placeholder*="body"], textarea:nth-of-type(2), textarea');
      if (bodyCodeArea) {
        let htmlToInsert = opts.html;
        if (opts.trackingSnippet) {
          htmlToInsert += '\n' + opts.trackingSnippet;
        }
        await bodyCodeArea.fill(htmlToInsert);
        log(steps, 'inject_html', 'ok', `HTML injected via Custom Codes (${htmlToInsert.length} chars)`);

        const saveCodesBtn = await page.$('button:has-text("Save"), button:has-text("Apply")');
        if (saveCodesBtn) {
          await saveCodesBtn.click();
          await page.waitForTimeout(2000);
        }
      }
    }
  }

  // Method B: Add Custom HTML element
  if (steps[steps.length - 1]?.step !== 'inject_html' || steps[steps.length - 1]?.status !== 'ok') {
    const addElementBtn = await page.$('button:has-text("Add"), [class*="add-element"], [class*="add-new"]');
    if (addElementBtn) {
      await addElementBtn.click();
      await page.waitForTimeout(2000);

      const customHtmlElement = await page.$('button:has-text("Custom HTML"), [class*="custom-html"], [data-element="custom-html"]');
      if (customHtmlElement) {
        await customHtmlElement.click();
        await page.waitForTimeout(2000);

        const editHtmlBtn = await page.$('button:has-text("Edit custom HTML"), [class*="edit-html"]');
        if (editHtmlBtn) {
          await editHtmlBtn.click();
          await page.waitForTimeout(1500);
        }

        const htmlEditor = await page.$('textarea, [contenteditable="true"], .CodeMirror');
        if (htmlEditor) {
          let htmlToInsert = opts.html;
          if (opts.trackingSnippet) {
            htmlToInsert += '\n' + opts.trackingSnippet;
          }

          const tag = await htmlEditor.evaluate((el) => el.tagName.toLowerCase());
          if (tag === 'textarea') {
            await htmlEditor.fill(htmlToInsert);
          } else {
            await page.evaluate((html) => {
              const cm = document.querySelector('.CodeMirror') as HTMLElement & { CodeMirror?: { setValue: (v: string) => void } };
              if (cm?.CodeMirror) cm.CodeMirror.setValue(html);
            }, htmlToInsert);
          }

          log(steps, 'inject_html', 'ok', `HTML injected via Custom HTML element (${htmlToInsert.length} chars)`, await screenshot(page));

          const saveChanges = await page.$('button:has-text("Save Changes"), button:has-text("Save")');
          if (saveChanges) {
            await saveChanges.click();
            await page.waitForTimeout(2000);
          }
        }
      } else {
        log(steps, 'inject_html', 'error', 'Custom HTML element not found');
        return { success: false, status: 'failed', error: 'Custom HTML element not found in Funnelish editor' };
      }
    }
  }

  // 7. Publish
  log(steps, 'publish', 'ok', 'Publishing funnel');
  const publishBtn = await page.$('button:has-text("Publish"), button:has-text("Save & Publish"), [class*="publish"]');
  if (publishBtn) {
    await publishBtn.click();
    await page.waitForTimeout(5000);
    log(steps, 'publish', 'ok', 'Published', await screenshot(page));
  }

  const currentUrl = page.url();
  return {
    success: true,
    status: 'completed',
    funnelUrl: currentUrl,
    previewUrl: currentUrl,
  };
}

/* ════════════════════════════════════════════════════════
   MAIN DEPLOY FUNCTION
   ════════════════════════════════════════════════════════ */

export async function deployFunnel(opts: DeployOptions): Promise<DeployResult> {
  const startTs = Date.now();
  const steps: DeployStepLog[] = [];
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser({ headless: opts.headless ?? true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    let partial: Partial<DeployResult>;

    if (opts.platform === 'checkout_champ') {
      partial = await deployToCheckoutChamp(page, opts, steps);
    } else {
      partial = await deployToFunnelish(page, opts, steps);
    }

    const finalScreenshot = await screenshot(page);

    return {
      platform: opts.platform,
      steps,
      durationMs: Date.now() - startTs,
      screenshotBase64: finalScreenshot,
      success: partial.success ?? true,
      status: partial.status ?? 'completed',
      funnelUrl: partial.funnelUrl,
      previewUrl: partial.previewUrl,
      error: partial.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(steps, 'fatal', 'error', msg);
    return {
      platform: opts.platform,
      steps,
      durationMs: Date.now() - startTs,
      success: false,
      status: 'failed',
      error: msg,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
