/**
 * Turn a checkout page into a WasabiCRM checkout.
 *
 * The rules in `checkout-modes.ts` only ever reached prompts that rewrite
 * TEXT — landing/swipe, funnel-swap-proxy and the OpenClaw worker all extract
 * strings, ask the model for {id, rewritten} pairs and put them back into the
 * cloned competitor's DOM. No prompt can add `data-wc-payment` from there, so
 * picking WasabiCRM produced an ordinary checkout page. This module is the
 * missing step: it takes the page those paths produce and makes it satisfy the
 * contract.
 *
 * Two halves, and the deterministic one runs whether or not the model does:
 *
 *   1. repairWasabiCheckout()  — wasabi-checkout-contract.ts. Everything a
 *      machine can decide on its own: strip the <base> and any runtime
 *      <script src>, claim the page's own email box and CTA, mount the payment
 *      host, dedupe fields, fix bind keys.
 *   2. Claude               — everything needing judgement: which <div> is the
 *      package picker (so it becomes [data-wc-options] + a <template>), which
 *      "$49.00" is the price (so it becomes a data-wc-bind) and which is
 *      decoration, where the payment host belongs in the design.
 *
 * Step 2 is best-effort by construction. No API key, a timeout, a truncated
 * response — the caller still gets step 1's output, and `ready` says whether
 * the page can take a payment. It never returns the model's raw answer: the
 * deterministic repair always runs again over it, and an attempt that comes
 * back with MORE fatal violations than we started with is discarded.
 */

// Relative imports, not the `@/` alias: this module is imported by
// netlify/functions/pipeline-swipe-background.mts too, and the functions
// bundler does not resolve the tsconfig path alias.
import Anthropic from '@anthropic-ai/sdk';
import { WASABI_CHECKOUT_RULES } from './checkout-modes';
import { getAnthropicKey } from './anthropic-key';
import {
  auditWasabiCheckout,
  fatalIssues,
  formatIssues,
  repairWasabiCheckout,
  type ContractIssue,
} from './wasabi-checkout-contract';

const MODEL = process.env.WASABI_CHECKOUT_MODEL || 'claude-opus-4-8';
const MAX_TOKENS = Number.parseInt(process.env.WASABI_CHECKOUT_MAX_TOKENS || '32000', 10) || 32000;

/**
 * Past this the model cannot echo the page back inside one response even with
 * the CSS tokenised, so we skip the AI pass rather than ship a truncated page.
 */
const MAX_AI_INPUT_CHARS = 420_000;

/** A model reply shorter than this share of its input was cut off mid-page. */
const MIN_OUTPUT_RATIO = 0.35;

export interface ConvertOptions {
  html: string;
  /** Used only for placeholder copy — the CRM supplies every real value. */
  productName?: string;
  brandName?: string;
  /** Free-text guidance appended to the conversion brief (e.g. a brief excerpt). */
  notes?: string;
  /** Default 2: one conversion, one repair round against what is still wrong. */
  maxAttempts?: number;
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface ConvertResult {
  html: string;
  /** No fatal violation left — the page can take a payment. */
  ready: boolean;
  issues: ContractIssue[];
  repairs: string[];
  /** Model round-trips actually made. */
  attempts: number;
  aiUsed: boolean;
  /** One line per notable event, for the funnel's swipe log and the editor. */
  log: string[];
  error?: string;
}

// ── protecting the heavy parts ────────────────────────────────────────────
//
// A cloned checkout is mostly inlined CSS and base64 images. The model has no
// reason to read either and cannot afford to echo them back, so their bodies
// travel as tokens and come home untouched. A token that does NOT come back
// means the model deleted that element, which §7 allows — we just drop the
// payload with it.

export interface Protection {
  html: string;
  payloads: Map<string, string>;
  styleTokens: number;
}

/** Exported for scripts/verify-wasabi-checkout.mjs — losing a stylesheet here
 *  would silently ship an unstyled checkout, so the round-trip is asserted. */
export function protectHeavyParts(html: string): Protection {
  const payloads = new Map<string, string>();
  let n = 0;
  let styleTokens = 0;

  const stash = (value: string, kind: 'S' | 'J' | 'D'): string => {
    const token = `__WC${kind}_${n++}__`;
    payloads.set(token, value);
    return token;
  };

  let out = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_all, open: string, body: string, close: string) => {
      if (body.length < 200) return `${open}${body}${close}`;
      styleTokens++;
      return `${open}/*${stash(body, 'S')}*/${close}`;
    },
  );

  out = out.replace(
    /(<script\b(?![^>]*\ssrc\s*=)[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_all, open: string, body: string, close: string) => {
      if (body.length < 200) return `${open}${body}${close}`;
      return `${open}/*${stash(body, 'J')}*/${close}`;
    },
  );

  // Long data: URIs in any attribute (src, href, srcset, style=url(...)).
  out = out.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{200,}/gi, (uri) =>
    stash(uri, 'D'),
  );

  return { html: out, payloads, styleTokens };
}

/** @see protectHeavyParts */
export function restoreHeavyParts(html: string, p: Protection): { html: string; missingStyles: number } {
  let out = html;
  let missingStyles = 0;
  for (const [token, value] of p.payloads) {
    if (!out.includes(token)) {
      if (token.startsWith('__WCS_')) missingStyles++;
      continue;
    }
    // Style and script tokens travel wrapped in /* */ so the tokenised page is
    // still valid CSS and JS. The WRAPPER has to go with the token: replacing
    // only the token leaves the restored stylesheet inside a comment, i.e. a
    // checkout with no styling at all. The wrapper is matched loosely because
    // the model may reformat the whitespace inside it.
    out = out.replace(new RegExp(`/\\*\\s*${token}\\s*\\*/`, 'g'), () => value);
    out = out.split(token).join(value);
  }
  return { html: out, missingStyles };
}

// ── prompt ────────────────────────────────────────────────────────────────

function conversionBrief(opts: ConvertOptions, issues: ContractIssue[], attempt: number): string {
  const product = opts.productName?.trim();
  const brand = opts.brandName?.trim();

  const lines: string[] = [];
  lines.push(
    attempt === 0
      ? 'TASK: convert the HTML below into a WasabiCRM checkout page.'
      : 'TASK: the HTML below is your previous answer after our automatic repairs. It still breaks the rules listed under VIOLATIONS. Fix exactly those, change nothing else.',
  );
  lines.push('');
  lines.push(
    'The page you are given is an ordinary checkout — a cloned competitor page, or one ' +
      'our copywriter rewrote. Its design, copy, imagery and layout are FINISHED and are ' +
      'not yours to redo. What is missing is the binding contract: the payment runtime ' +
      'has nothing to bind to, so the page paints and takes no money.',
  );
  lines.push('');
  lines.push('Keep the design. Add the contract:');
  lines.push(
    '- Put [data-wc-payment] (one, empty) where the card form belongs in THIS design — ' +
      'where the competitor\'s own card fields were, or directly above the pay button.',
  );
  lines.push(
    '- Mark the buyer inputs the page already has with data-wc-field (email is required; ' +
      'firstName, lastName, phone only if the design has them). Add an email input only if ' +
      'there is none.',
  );
  lines.push('- Mark the real CTA [data-wc-submit]. Delete any other checkout/pay button.');
  lines.push(
    '- Every price, total, currency, billing term, product name and order value that ' +
      'appears as literal text becomes a data-wc-bind element from the §6 list. This is the ' +
      'rule the page in front of you breaks most: the funnel supplies those values at ' +
      'render time, so a hardcoded number ships the wrong price to a real buyer.',
  );
  lines.push(
    '- If the design offers a choice of packages/quantities, turn ONE card into ' +
      '<template data-wc-option-item> inside [data-wc-options] and DELETE the hand-placed ' +
      'siblings — the runtime stamps one card per thing the funnel sells. If it sells one ' +
      'thing, no picker.',
  );
  lines.push(
    '- Delete the competitor\'s own payment machinery: their card iframes, their ' +
      'processor scripts, their order forms, their "secure checkout" widgets that talk to ' +
      'someone else\'s API.',
  );
  lines.push('');
  if (product) lines.push(`Product name for placeholder copy: ${product}`);
  if (brand) lines.push(`Brand name for placeholder copy: ${brand}`);
  if (product || brand) {
    lines.push(
      '(Placeholder only — anything inside a data-wc-bind is replaced at render time. ' +
        'Never invent a price, a was-price or a discount.)',
    );
    lines.push('');
  }
  if (opts.notes?.trim()) {
    lines.push(`Context from the operator:\n${opts.notes.trim()}`);
    lines.push('');
  }
  if (issues.length) {
    lines.push('VIOLATIONS found in the HTML below by our own checker:');
    lines.push(formatIssues(issues));
    lines.push('');
  }
  lines.push(
    'OUTPUT: the complete converted HTML and nothing else. No commentary, no ``` fence. ' +
      'Tokens that look like __WCS_3__, __WCJ_1__ or __WCD_7__ are stylesheets, scripts and ' +
      'images we took out to keep this message small — reproduce every one you keep ' +
      'character for character, and drop only the ones whose element you deliberately delete.',
  );
  return lines.join('\n');
}

function cleanModelHtml(text: string): string {
  let out = text.trim();
  out = out.replace(/^```(?:html)?\s*\n?/i, '');
  out = out.replace(/\n?```\s*$/i, '');
  return out.trim();
}

// ── the pipeline ──────────────────────────────────────────────────────────

/**
 * Convert `html` into a page that satisfies the WasabiCRM contract.
 * Never throws: a failed AI pass degrades to the deterministic repair.
 */
export async function convertToWasabiCheckout(opts: ConvertOptions): Promise<ConvertResult> {
  const log: string[] = [];
  const source = String(opts.html || '');

  if (!source.trim()) {
    return {
      html: source, ready: false, issues: [], repairs: [], attempts: 0, aiUsed: false,
      log, error: 'empty html',
    };
  }

  const before = auditWasabiCheckout(source);
  log.push(
    `Audit before: ${fatalIssues(before).length} payment-fatal, ${before.length - fatalIssues(before).length} advisory.`,
  );

  // Deterministic floor. Computed first and kept: it is what we fall back to,
  // and it is what the model is asked to improve on.
  const floor = repairWasabiCheckout(source, { scaffold: true });
  for (const r of floor.repairs) log.push(`Repair: ${r}`);
  let best = floor;

  if (fatalIssues(floor.issues).length === 0) {
    log.push('Deterministic repair alone satisfied the contract — no model call needed.');
    return {
      html: floor.html, ready: true, issues: floor.issues, repairs: floor.repairs,
      attempts: 0, aiUsed: false, log,
    };
  }

  const apiKey = (opts.apiKey || getAnthropicKey()).trim();
  if (!apiKey) {
    log.push(
      'ANTHROPIC_API_KEY is not set, so the judgement half (prices → data-wc-bind, package ' +
        'picker → <template>) did not run. The page is structurally wired but still needs a pass.',
    );
    return {
      html: floor.html, ready: false, issues: floor.issues, repairs: floor.repairs,
      attempts: 0, aiUsed: false, log, error: 'ANTHROPIC_API_KEY not configured',
    };
  }

  // The model is given the page as it ARRIVED, minus the payment-fatal junk —
  // not the scaffolded floor. Our scaffolding bolts controls onto the end of
  // <body>; the model's job includes putting them where the design wants them.
  const cleaned = repairWasabiCheckout(source, { scaffold: false });
  const protectedSource = protectHeavyParts(cleaned.html);

  if (protectedSource.html.length > MAX_AI_INPUT_CHARS) {
    log.push(
      `Page is ${Math.round(protectedSource.html.length / 1000)}KB even with stylesheets and ` +
        'images taken out — too large for one model round-trip, so only the deterministic ' +
        'repair ran. Split the page or convert it in the Visual HTML Editor.',
    );
    return {
      html: floor.html, ready: false, issues: floor.issues, repairs: floor.repairs,
      attempts: 0, aiUsed: false, log, error: 'page too large for the conversion pass',
    };
  }

  const anthropic = new Anthropic({ apiKey });
  const model = opts.model || MODEL;
  const maxAttempts = Math.max(1, Math.min(3, opts.maxAttempts ?? 2));

  let current = protectedSource.html;
  let currentIssues = cleaned.issues;
  let attempts = 0;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let answer: string;
    try {
      attempts++;
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: `${WASABI_CHECKOUT_RULES}\n\nYou are converting a finished checkout design into a WasabiCRM checkout. The rules above are the contract; everything below is the job.`,
          messages: [
            {
              role: 'user',
              content: `${conversionBrief(opts, currentIssues, attempt)}\n\nHTML:\n${current}`,
            },
          ],
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );
      answer = response.content[0]?.type === 'text' ? response.content[0].text : '';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.push(`Conversion attempt ${attempt + 1} failed: ${lastError}`);
      break;
    }

    const produced = cleanModelHtml(answer);
    if (produced.length < current.length * MIN_OUTPUT_RATIO) {
      lastError = `model returned ${produced.length} chars for a ${current.length} char page — truncated`;
      log.push(`Conversion attempt ${attempt + 1} discarded: ${lastError}.`);
      break;
    }

    const restored = restoreHeavyParts(produced, protectedSource);
    if (protectedSource.styleTokens > 0 && restored.missingStyles / protectedSource.styleTokens > 0.5) {
      lastError = `model dropped ${restored.missingStyles}/${protectedSource.styleTokens} stylesheets`;
      log.push(`Conversion attempt ${attempt + 1} discarded: ${lastError}.`);
      break;
    }

    // Never trust the answer directly: the deterministic repair runs over it
    // too, which is what caught the hand-written <script src> that broke a
    // live page once already.
    const settled = repairWasabiCheckout(restored.html, { scaffold: true });
    const settledFatal = fatalIssues(settled.issues).length;
    const bestFatal = fatalIssues(best.issues).length;
    log.push(
      `Conversion attempt ${attempt + 1}: ${settledFatal} payment-fatal left ` +
        `(deterministic-only leaves ${bestFatal}).`,
    );
    for (const r of settled.repairs) log.push(`Repair after model: ${r}`);

    if (settledFatal <= bestFatal) best = settled;

    if (settledFatal === 0) break;

    // Feed the model back its own output and what is still wrong with it.
    const reProtected = protectHeavyParts(settled.html);
    current = reProtected.html;
    currentIssues = settled.issues;
    protectedSource.payloads = reProtected.payloads;
    protectedSource.styleTokens = reProtected.styleTokens;
  }

  const ready = fatalIssues(best.issues).length === 0;
  log.push(
    ready
      ? 'Contract satisfied — the page can take a payment.'
      : `${fatalIssues(best.issues).length} payment-fatal issue(s) remain; see the report.`,
  );

  return {
    html: best.html,
    ready,
    issues: best.issues,
    repairs: best.repairs,
    attempts,
    aiUsed: attempts > 0,
    log,
    error: ready ? undefined : lastError,
  };
}
