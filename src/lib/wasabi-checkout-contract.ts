/**
 * The WasabiCRM checkout contract, as CODE.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/lib/checkout-modes.ts` states the contract in prose and appends it to
 * the system prompt of every AI that can touch a checkout page. That was
 * enough to stop a model BREAKING a page that was already wired — and nothing
 * more. Three of the five consumers (landing/swipe, funnel-swap-proxy, the
 * OpenClaw worker) are text-only rewriters: they extract strings, ask the
 * model for {id, rewritten} pairs and substitute them back into the cloned
 * competitor's DOM. A prompt cannot make such a path emit `data-wc-payment`.
 *
 * So picking "WasabiCRM" produced an ordinary checkout page. This module is
 * the half that was missing: the contract expressed as checks that run over
 * the HTML, plus the repairs for every violation a machine can fix on its own.
 *
 * Section numbers (§1.1, §4.4 …) refer to WASABI_CHECKOUT_RULES so a finding
 * here and the model-facing text can never drift apart silently —
 * scripts/verify-wasabi-checkout.mjs asserts that every rule cited below is
 * actually present in that constant.
 *
 * Two entry points:
 *   auditWasabiCheckout(html)   → what is wrong, nothing touched
 *   repairWasabiCheckout(html)  → fix what is mechanically fixable, then audit
 *
 * `repair` is deliberately conservative. It only makes changes that are
 * true of EVERY valid WasabiCRM checkout (strip a <base>, empty the payment
 * mount, dedupe a field, rename data-wc-next). Everything needing judgement —
 * which of these <div>s is the package picker, which text is a price — is left
 * to the AI pass in wasabi-checkout-build.ts and reported here as an issue.
 */

import { parse, HTMLElement, NodeType, type Node } from 'node-html-parser';

// ── the contract's vocabulary ─────────────────────────────────────────────

/** §0 / §1.4 — the CRM injects these; our output must never name one. */
export const RUNTIME_SCRIPT_FILENAMES = [
  'loader.js',
  'wasabi-checkout.js',
  'wasabi-page.js',
  'whop-submit-button.js',
  'wasabi-editor.js',
] as const;

/** §1.3 — exact camelCase; the runtime reads `.value` off each. */
export const WC_FIELD_NAMES = ['email', 'firstName', 'lastName', 'phone'] as const;

/** §1.6 — the runtime resolves these globally; a duplicate steals the embed. */
export const WC_RESERVED_IDS = [
  'wc-payment',
  'wc-submit',
  'wc-sub-modal',
  'wc-sub-embed',
  'wc-sub-express',
  'wc-sub-submit',
  'wc-payment-host',
] as const;

/** §6 — the whole list. A key off it resolves to null and ships the placeholder. */
export const WC_BIND_KEYS = [
  'product.name', 'product.description', 'product.price', 'product.priceRaw',
  'product.image', 'total', 'subtotal', 'currency',
  'brand.name', 'brand.logo', 'brand.support',
  'option.name', 'option.description', 'option.price', 'option.priceRaw',
  'option.image', 'option.terms', 'option.index', 'option.total',
  'bump.name', 'bump.description', 'bump.price', 'bump.priceRaw',
] as const;

/**
 * §5.2 — a *wrong* key defeats the money guard instead of triggering it, and
 * `*.renewal` is the one the models reach for. The billing line is
 * `option.terms`; map it rather than reporting a fatal we can fix.
 */
const BIND_KEY_ALIASES: Record<string, string> = {
  'option.renewal': 'option.terms',
  'product.renewal': 'option.terms',
  'bump.renewal': 'option.terms',
  'renewal': 'option.terms',
  'option.billing': 'option.terms',
  'price': 'product.price',
  'product.total': 'total',
  'brand.support_email': 'brand.support',
};

/** §3 — stamped by the runtime at render time; machine state, not markup. */
const RUNTIME_STATE_ATTRS = [
  'data-wc-priced',
  'data-wc-js',
  'data-wc-steps-ready',
  'data-wc-step-active',
  'data-wc-option',
  'data-wc-option-kind',
  'data-wc-required',
  'data-wc-unavailable',
  'data-wc-authored',
  'data-wc-display0',
] as const;

/**
 * §3 also lists `aria-checked` / `aria-disabled` as runtime-stamped — but only
 * where the runtime stamps them, which is the option and bump cards. Every
 * other `aria-*` on the page is the author's (§7), so these are stripped
 * inside a wc container and left alone everywhere else.
 */
const RUNTIME_ARIA_ATTRS = ['aria-checked', 'aria-disabled'] as const;
const WC_STAMPED_CONTAINERS = '[data-wc-options], [data-wc-bumps], [data-wc-option-item]';

/** §4.3 — the runtime reveals these; a CSS rule or inline display beats it. */
const RUNTIME_TOGGLED_ATTRS = [
  'data-wc-options',
  'data-wc-bumps',
  'data-wc-error',
  'data-wc-when',
  'data-wc-loading',
  'data-wc-hide-until-ready',
  'data-wc-step',
  'data-wc-step-back',
  'data-wc-submit',
] as const;

const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

// ── findings ──────────────────────────────────────────────────────────────

export type IssueSeverity = 'fatal' | 'warn';

export interface ContractIssue {
  /** Section of WASABI_CHECKOUT_RULES this comes from, e.g. '§1.1'. */
  rule: string;
  severity: IssueSeverity;
  message: string;
  /** How many elements are involved, when that is meaningful. */
  count?: number;
}

export interface RepairResult {
  html: string;
  /** Human-readable list of what was changed, in the order applied. */
  repairs: string[];
  /** What is still wrong AFTER the repairs — the AI pass's worklist. */
  issues: ContractIssue[];
}

/** No fatal issue left = the page can take a payment. */
export function isWasabiCheckoutReady(html: string): boolean {
  return auditWasabiCheckout(html).every((i) => i.severity !== 'fatal');
}

export function fatalIssues(issues: ContractIssue[]): ContractIssue[] {
  return issues.filter((i) => i.severity === 'fatal');
}

/** One line per issue, for a prompt or a log. */
export function formatIssues(issues: ContractIssue[]): string {
  return issues
    .map((i) => `- [${i.severity.toUpperCase()} ${i.rule}] ${i.message}`)
    .join('\n');
}

// ── text-level checks (§0, §1.4, §1.6, §2) ────────────────────────────────
//
// These run over the RAW STRING, not the DOM, because that is how the CRM
// itself decides: ensureScript() matches a filename against the raw HTML text
// and is blind to comments, so a commented-out tag suppresses the real
// injection just as well as a live one (§1.4).

const runtimeScriptRe = new RegExp(
  `<script[^>]*\\ssrc\\s*=\\s*["']?[^"'>]*(?:${RUNTIME_SCRIPT_FILENAMES.map((f) =>
    f.replace('.', '\\.'),
  ).join('|')})`,
  'i',
);

const runtimePreloadRe = new RegExp(
  `<link[^>]*(?:${RUNTIME_SCRIPT_FILENAMES.map((f) => f.replace('.', '\\.')).join('|')})[^>]*>`,
  'i',
);

const wasabiAssignRe = /(?:window\s*\.\s*)?__WASABI__\s*=/;
const completeDispatchRe = /dispatchEvent\s*\(\s*new\s+(?:Custom)?Event\s*\(\s*['"]complete['"]/i;
const purchasePixelRe =
  /fbq\s*\(\s*['"]track['"]\s*,\s*['"]Purchase['"]|gtag\s*\(\s*['"]event['"]\s*,\s*['"]purchase['"]|ttq\s*\.\s*track\s*\(\s*['"]CompletePayment['"]|['"]event['"]\s*:\s*['"]purchase['"]/i;

function auditText(html: string, issues: ContractIssue[]): void {
  if (runtimeScriptRe.test(html)) {
    issues.push({
      rule: '§1.4',
      severity: 'fatal',
      message:
        'A <script src> naming a CRM runtime file is present in the output text. ' +
        'ensureScript() matches the raw string, so this SUPPRESSES the server\'s own ' +
        'injection and the page can never start a checkout. Delete the tag (do not comment it out).',
    });
  }
  if (runtimePreloadRe.test(html)) {
    issues.push({
      rule: '§0',
      severity: 'fatal',
      message: 'A <link> references a CRM runtime file. The server injects those; remove it.',
    });
  }
  if (/<base[\s>]/i.test(html)) {
    issues.push({
      rule: '§0',
      severity: 'fatal',
      message:
        '<base> re-roots every relative URL, so the injected /js/ runtimes 404 and ' +
        '/api/payments/checkout/funnel/init never answers.',
    });
  }
  if (wasabiAssignRe.test(html)) {
    issues.push({
      rule: '§0',
      severity: 'fatal',
      message:
        'The page assigns window.__WASABI__. The server injects it with the funnel\'s real ' +
        'prices; overwriting it ships the designer\'s placeholder money.',
    });
  }
  if (completeDispatchRe.test(html)) {
    issues.push({
      rule: '§1.6',
      severity: 'fatal',
      message:
        "A bubbling `complete` event is dispatched. The runtime reads that as a finished " +
        'purchase and fires the postback and upsell chain for a buyer who never paid.',
    });
  }
  if (purchasePixelRe.test(html)) {
    issues.push({
      rule: '§2',
      severity: 'fatal',
      message:
        'A purchase/conversion pixel fires on this page. Those fire server-side on ' +
        '/checkout/complete, so one here double-counts and credits buyers who never paid.',
    });
  }
}

/**
 * Remove every runtime `<script src>` / preload `<link>` / `<base>`, including
 * ones hidden inside an HTML comment (§1.4 — the CRM's matcher is textual, so a
 * comment counts). Done on the string, before parsing, for the same reason.
 */
function repairText(html: string, repairs: string[]): string {
  let out = html;

  // Comments first: a comment wrapping a runtime tag must go WHOLE, otherwise
  // stripping the tag leaves `<!-- -->` and stripping neither leaves the match.
  out = out.replace(/<!--[\s\S]*?-->/g, (comment) => {
    if (runtimeScriptRe.test(comment) || runtimePreloadRe.test(comment) || /<base[\s>]/i.test(comment)) {
      repairs.push('§1.4 removed an HTML comment containing a CRM runtime tag (the matcher is textual — a comment suppresses the real injection)');
      return '';
    }
    return comment;
  });

  const scriptTagRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/>/gi;
  out = out.replace(scriptTagRe, (tag) => {
    if (runtimeScriptRe.test(tag)) {
      repairs.push('§1.4 removed a <script src> naming a CRM runtime file');
      return '';
    }
    return tag;
  });

  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (runtimePreloadRe.test(tag)) {
      repairs.push('§0 removed a <link> referencing a CRM runtime file');
      return '';
    }
    return tag;
  });

  out = out.replace(/<base\b[^>]*>/gi, () => {
    repairs.push('§0 removed <base> (it re-roots every relative URL and 404s the runtimes)');
    return '';
  });

  return out;
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function parseHtml(html: string): HTMLElement | null {
  try {
    return parse(html, {
      comment: true,
      blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true },
    });
  } catch {
    return null;
  }
}

function tagOf(el: HTMLElement): string {
  return String(el.rawTagName || '').toUpperCase();
}

function isAncestor(ancestor: HTMLElement, node: HTMLElement): boolean {
  let cur: Node | null = node.parentNode as Node | null;
  while (cur) {
    if (cur === ancestor) return true;
    cur = (cur as HTMLElement).parentNode as Node | null;
  }
  return false;
}

/** The element itself or the nearest ancestor carrying `attr`, else null. */
function selfOrAncestorWith(el: HTMLElement, attr: string): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur && cur.nodeType === NodeType.ELEMENT_NODE) {
    if (typeof cur.hasAttribute === 'function' && cur.hasAttribute(attr)) return cur;
    cur = (cur.parentNode as HTMLElement) || null;
  }
  return null;
}

/** Document-order list; node-html-parser already returns querySelectorAll in it. */
function all(root: HTMLElement, sel: string): HTMLElement[] {
  try {
    return root.querySelectorAll(sel) as unknown as HTMLElement[];
  } catch {
    return [];
  }
}

/** The element a scaffolded control should land next to, best effort. */
function scaffoldHost(root: HTMLElement): HTMLElement {
  const firstStep = all(root, '[data-wc-step]')[0];
  if (firstStep) return firstStep;
  return root.querySelector('body') || root;
}

// ── adopting the design's own controls ────────────────────────────────────
//
// A cloned competitor checkout already has an email box, a name box and a
// "Complete order" button. They carry no data-wc-* attribute, so the runtime
// ignores every one of them. Claiming the existing control is always better
// than appending a new one: the buyer sees the design, not a bolted-on field.

/** Matched against name / id / placeholder / autocomplete / label text. */
const FIELD_HINTS: { field: (typeof WC_FIELD_NAMES)[number]; re: RegExp; inputType?: RegExp }[] = [
  { field: 'email', re: /e-?mail|correo|courriel|posta/i, inputType: /^email$/i },
  { field: 'firstName', re: /first[\s_-]*name|given[\s_-]*name|\bfname\b|nome|prénom|prenom|vorname|nombre/i },
  { field: 'lastName', re: /last[\s_-]*name|surname|family[\s_-]*name|\blname\b|cognome|apellido|nachname/i },
  { field: 'phone', re: /phone|tel(?:ephone)?|mobile|cellulare|telefono|téléphone/i, inputType: /^tel$/i },
];

/** Text of a CTA that means "pay", in the languages this tool swipes in. */
const PAY_TEXT_RE =
  /\b(pay|buy|order|purchase|checkout|complete|continue|get\s+(?:it|yours|started)|claim|paga|acquista|ordina|compra|completa|kaufen|bestellen|comprar|pedir|acheter|commander)\b/i;

function fieldSignature(el: HTMLElement): string {
  return [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ');
}

function adoptControls(root: HTMLElement, repairs: string[]): void {
  // ── buyer fields ──
  const inputs = all(root, 'input, select, textarea').filter(
    (el) => !el.hasAttribute('data-wc-field'),
  );
  for (const { field, re, inputType } of FIELD_HINTS) {
    if (all(root, `[data-wc-field="${field}"]`).length > 0) continue;
    const hit = inputs.find((el) => {
      if (el.hasAttribute('data-wc-field')) return false;
      const type = (el.getAttribute('type') || '').trim();
      if (type && /^(hidden|submit|button|image|reset|file)$/i.test(type)) return false;
      if (inputType && inputType.test(type)) return true;
      return re.test(fieldSignature(el));
    });
    if (!hit) continue;
    hit.setAttribute('data-wc-field', field);
    repairs.push(`§1.3 claimed the page's own <${String(hit.rawTagName).toLowerCase()}> as data-wc-field="${field}"`);
  }

  // ── the pay button ──
  if (all(root, '[data-wc-submit]').length === 0) {
    const candidates = all(root, 'button, a, [role="button"]').filter((el) => {
      const text = el.text.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) return false;
      return PAY_TEXT_RE.test(text);
    });
    // A <button> beats an <a>: on a long-form page the anchors are scroll
    // links to the real control, and one of them ("Continue…") can easily
    // outrank it on text alone. Within a kind, the LAST in document order —
    // the real CTA sits under the form, the ones above it point down to it.
    const buttons = candidates.filter((el) => tagOf(el) === 'BUTTON');
    const pool = buttons.length ? buttons : candidates;
    const cta = pool[pool.length - 1];
    if (cta) {
      cta.setAttribute('data-wc-submit', '');
      if (tagOf(cta) === 'BUTTON') cta.setAttribute('type', 'button');
      cta.removeAttribute('href');
      repairs.push(`§1.5 claimed the page's own CTA ("${cta.text.replace(/\s+/g, ' ').trim().slice(0, 40)}") as [data-wc-submit]`);
    }
  }
}

// ── the DOM pass ──────────────────────────────────────────────────────────

interface DomPassOptions {
  /** false = report only, change nothing. */
  repair: boolean;
  /**
   * Add a payment mount / email field when they are missing. Only the
   * conversion pipeline wants this; the editor's post-edit repair must not
   * inject controls into a page the user is in the middle of designing.
   */
  scaffold: boolean;
}

function domPass(
  html: string,
  opts: DomPassOptions,
  repairs: string[],
  issues: ContractIssue[],
): string {
  const root = parseHtml(html);
  if (!root) {
    issues.push({
      rule: '§0',
      severity: 'fatal',
      message: 'The HTML could not be parsed. Emit a well-formed fragment.',
    });
    return html;
  }

  const { repair, scaffold } = opts;

  // §3 — machine state in the input is not markup to preserve.
  for (const attr of RUNTIME_STATE_ATTRS) {
    const hits = all(root, `[${attr}]`);
    if (hits.length === 0) continue;
    if (!repair) {
      issues.push({
        rule: '§3',
        severity: attr === 'data-wc-priced' ? 'fatal' : 'warn',
        message: `${hits.length} element(s) carry the runtime-stamped attribute ${attr}.` +
          (attr === 'data-wc-priced'
            ? ' On <html> it permanently defeats the money guard and ships the placeholder price.'
            : ''),
        count: hits.length,
      });
      continue;
    }
    for (const el of hits) el.removeAttribute(attr);
    repairs.push(`§3 stripped ${attr} from ${hits.length} element(s)`);
  }

  for (const container of all(root, WC_STAMPED_CONTAINERS)) {
    for (const attr of RUNTIME_ARIA_ATTRS) {
      const hits = all(container, `[${attr}]`);
      if (hits.length === 0) continue;
      if (!repair) {
        issues.push({
          rule: '§3',
          severity: 'warn',
          message: `${hits.length} element(s) inside an option/bump container author ${attr}; the runtime stamps it.`,
          count: hits.length,
        });
        continue;
      }
      for (const el of hits) el.removeAttribute(attr);
      repairs.push(`§3 stripped ${attr} from ${hits.length} element(s) inside an option/bump container`);
    }
  }

  const injected = all(root, '[data-wasabi-injected]');
  if (injected.length) {
    if (repair) {
      for (const el of injected) el.remove();
      repairs.push(`§3 removed ${injected.length} [data-wasabi-injected] node(s)`);
    } else {
      issues.push({
        rule: '§3',
        severity: 'warn',
        message: `${injected.length} node(s) were injected by the runtime and must not be authored.`,
        count: injected.length,
      });
    }
  }

  // Before anything else: a cloned checkout already HAS an email box and a
  // CTA — they just carry none of the contract's attributes. Claiming those
  // beats bolting new controls onto the end of <body>, and it is what makes
  // the no-AI path produce a page that still looks like the design.
  if (repair && scaffold) adoptControls(root, repairs);

  // §4.3 — nothing the runtime must reveal may sit inside a <form>: no
  // listener answers `submit`, so Enter reloads and discards the mounted
  // session. Downgrade the form to a plain container.
  for (const form of all(root, 'form')) {
    const owns =
      form.querySelector('[data-wc-field]') ||
      form.querySelector('[data-wc-submit]') ||
      form.querySelector('[data-wc-payment]');
    if (!owns) continue;
    if (!repair) {
      issues.push({
        rule: '§4.3',
        severity: 'fatal',
        message:
          'Buyer fields sit inside a <form>. Nothing listens for `submit`, so Enter or a ' +
          'type="submit" control reloads the page and discards the mounted checkout session.',
      });
      continue;
    }
    form.rawTagName = 'div';
    for (const attr of ['action', 'method', 'enctype', 'target', 'novalidate', 'onsubmit']) {
      form.removeAttribute(attr);
    }
    repairs.push('§4.3 turned a <form> around the buyer fields into a <div>');
  }

  // §1.5 — a type="submit" control reloads the page for the same reason.
  // De-duplicated: a <button data-wc-submit type="submit"> matches two of
  // these selectors and would otherwise be reported twice.
  const submitControls = new Set<HTMLElement>([
    ...all(root, '[data-wc-submit]'),
    ...all(root, 'button'),
    ...all(root, 'input'),
  ]);
  for (const el of submitControls) {
    if ((el.getAttribute('type') || '').toLowerCase() !== 'submit') continue;
    if (!repair) {
      issues.push({
        rule: '§1.5',
        severity: 'fatal',
        message: 'A type="submit" control is present; it reloads the page instead of paying.',
      });
      continue;
    }
    el.setAttribute('type', 'button');
    repairs.push('§1.5 changed a type="submit" control to type="button"');
  }

  // §1.6 — never take the runtime's names.
  for (const id of WC_RESERVED_IDS) {
    const hits = all(root, `#${id}`);
    if (hits.length === 0) continue;
    if (!repair) {
      issues.push({
        rule: '§1.6',
        severity: 'fatal',
        message: `id="${id}" is the runtime's own; it resolves globally and steals the embed's identity.`,
        count: hits.length,
      });
      continue;
    }
    for (const el of hits) el.removeAttribute('id');
    repairs.push(`§1.6 removed the reserved id="${id}"`);
  }

  // §4.5 — data-wc-next on a checkout navigates to /checkout/complete with no
  // ?order=, which renders a fake "Payment confirmed" AND fires every pixel.
  const nextNodes = all(root, '[data-wc-next]');
  if (nextNodes.length) {
    if (!repair) {
      issues.push({
        rule: '§4.5',
        severity: 'fatal',
        message:
          'data-wc-next is present. On a checkout it falls through to /checkout/complete with ' +
          'no ?order=, rendering a fake "Payment confirmed" and firing every purchase pixel. ' +
          'Use data-wc-step-next, and only when another [data-wc-step] follows.',
        count: nextNodes.length,
      });
    } else {
      const hasSteps = all(root, '[data-wc-step]').length > 1;
      for (const el of nextNodes) {
        el.removeAttribute('data-wc-next');
        if (hasSteps) el.setAttribute('data-wc-step-next', '');
      }
      repairs.push(
        hasSteps
          ? `§4.5 renamed data-wc-next to data-wc-step-next on ${nextNodes.length} element(s)`
          : `§4.5 removed data-wc-next from ${nextNodes.length} element(s) (no further step to go to)`,
      );
    }
  }

  // §1.1 — exactly one [data-wc-payment], left empty.
  let payments = all(root, '[data-wc-payment]');
  if (payments.length > 1) {
    if (repair) {
      for (const el of payments.slice(1)) el.removeAttribute('data-wc-payment');
      repairs.push(`§1.1 kept the first [data-wc-payment] and unwrapped ${payments.length - 1} duplicate(s)`);
      payments = all(root, '[data-wc-payment]');
    } else {
      issues.push({
        rule: '§1.1',
        severity: 'fatal',
        message: `${payments.length} [data-wc-payment] elements. There must be exactly one.`,
        count: payments.length,
      });
    }
  }

  // §4.2 — [data-wc-loading] must not live inside the payment host: the host
  // is emptied at mount, so the node is destroyed and the ~12s timeout message
  // never has anywhere to print. Move it out, never delete it.
  const payment = payments[0];
  if (payment) {
    const insideLoading = all(payment, '[data-wc-loading]');
    if (insideLoading.length) {
      if (repair) {
        for (const node of insideLoading) {
          payment.insertAdjacentHTML('afterend', node.toString());
          node.remove();
        }
        repairs.push(`§4.2 moved ${insideLoading.length} [data-wc-loading] node(s) out of [data-wc-payment]`);
      } else {
        issues.push({
          rule: '§4.2',
          severity: 'fatal',
          message: '[data-wc-loading] is inside [data-wc-payment]; the mount wipes it, so the failure message has no surface.',
          count: insideLoading.length,
        });
      }
    }

    if (payment.childNodes.length > 0) {
      if (repair) {
        payment.set_content('');
        repairs.push('§1.1 emptied [data-wc-payment] (its innerHTML is wiped at mount anyway)');
      } else {
        issues.push({
          rule: '§1.1',
          severity: 'warn',
          message: '[data-wc-payment] is not empty. mountPayment() wipes its innerHTML at mount.',
        });
      }
    }

    // §4.3 — hide-until-ready is never revealed on the failure path, so an
    // error inside it stays invisible.
    for (const el of [payment, ...all(root, '[data-wc-submit]'), ...all(root, '[data-wc-wallet]')]) {
      const hider = selfOrAncestorWith(el, 'data-wc-hide-until-ready');
      if (!hider) continue;
      if (repair) {
        hider.removeAttribute('data-wc-hide-until-ready');
        repairs.push('§4.3 removed data-wc-hide-until-ready from around the payment mount / pay button (it is never revealed on the failure path, so the error stays invisible)');
      } else {
        issues.push({
          rule: '§4.3',
          severity: 'fatal',
          message: 'data-wc-hide-until-ready wraps the payment mount or pay button; on the failure path it is never revealed, so the error is invisible.',
        });
      }
    }
  } else if (scaffold && repair) {
    const host = scaffoldHost(root);
    const anchor = all(root, '[data-wc-submit]')[0];
    const markup = '<div id="pay" data-wc-payment></div>';
    if (anchor) anchor.insertAdjacentHTML('beforebegin', markup);
    else host.insertAdjacentHTML('beforeend', markup);
    repairs.push('§1.1 scaffolded the missing [data-wc-payment] mount');
  } else {
    issues.push({
      rule: '§1.1',
      severity: 'fatal',
      message:
        'No [data-wc-payment]. It is the only element the runtime requires and the only ' +
        'surface an error can print to — without it the page paints and takes no money.',
    });
  }

  // §1.2 / §1.3 — one element per data-wc-field value, each on a real control.
  const byField = new Map<string, HTMLElement[]>();
  for (const el of all(root, '[data-wc-field]')) {
    const name = (el.getAttribute('data-wc-field') || '').trim();
    if (!name) continue;
    const list = byField.get(name) || [];
    list.push(el);
    byField.set(name, list);
  }

  for (const [name, els] of byField) {
    if (!(WC_FIELD_NAMES as readonly string[]).includes(name)) {
      issues.push({
        rule: '§1.3',
        severity: 'warn',
        message: `data-wc-field="${name}" is not one of ${WC_FIELD_NAMES.join(', ')}; the runtime never reads it.`,
      });
    }

    // On a <div> the runtime reads `.value` and gets nothing, forever — the
    // pay button stays locked. Move the attribute onto the control inside.
    for (const el of els) {
      if (FIELD_TAGS.has(tagOf(el))) continue;
      const inner = el.querySelector('input, select, textarea');
      if (inner && repair) {
        el.removeAttribute('data-wc-field');
        inner.setAttribute('data-wc-field', name);
        repairs.push(`§1.3 moved data-wc-field="${name}" onto the <${String(inner.rawTagName).toLowerCase()}> inside it`);
      } else {
        issues.push({
          rule: '§1.3',
          severity: 'fatal',
          message: `data-wc-field="${name}" sits on a <${tagOf(el).toLowerCase()}>. The runtime reads .value, so it reads empty forever and the pay button stays locked.`,
        });
      }
    }

    const live = (byField.get(name) || []).filter((el) => el.getAttribute('data-wc-field') === name);
    if (live.length > 1) {
      if (repair) {
        for (const el of live.slice(1)) el.removeAttribute('data-wc-field');
        repairs.push(`§1.3 kept the first data-wc-field="${name}" and dropped ${live.length - 1} duplicate(s)`);
      } else {
        issues.push({
          rule: '§1.3',
          severity: 'fatal',
          message: `${live.length} elements carry data-wc-field="${name}". The lookup is querySelector, so the buyer types into a copy the runtime never reads.`,
          count: live.length,
        });
      }
    }
  }

  // §1.2 — the email field is required: without it the buyer is charged and
  // the order lands with no email.
  if (all(root, '[data-wc-field="email"]').length === 0) {
    if (scaffold && repair) {
      const target = all(root, '[data-wc-payment]')[0];
      const markup =
        '<div class="wc-field"><label>Email<input type="email" data-wc-field="email" ' +
        'autocomplete="email" placeholder="you@example.com"></label></div>';
      if (target) target.insertAdjacentHTML('beforebegin', markup);
      else scaffoldHost(root).insertAdjacentHTML('beforeend', markup);
      repairs.push('§1.2 scaffolded the required [data-wc-field="email"]');
    } else {
      issues.push({
        rule: '§1.2',
        severity: 'fatal',
        message:
          'No [data-wc-field="email"]. Whop\'s own email box is hidden unconditionally, so this ' +
          'is the only email the order ever receives — the buyer is charged and the order has none.',
      });
    }
  }

  // §1.3 — data-wc-error is querySelector too.
  const byError = new Map<string, number>();
  for (const el of all(root, '[data-wc-error]')) {
    const name = (el.getAttribute('data-wc-error') || '').trim();
    byError.set(name, (byError.get(name) || 0) + 1);
  }
  for (const [name, count] of byError) {
    if (count <= 1) continue;
    if (repair) {
      const dupes = all(root, `[data-wc-error="${name}"]`).slice(1);
      for (const el of dupes) el.removeAttribute('data-wc-error');
      repairs.push(`§1.3 dropped ${dupes.length} duplicate data-wc-error="${name}"`);
    } else {
      issues.push({
        rule: '§1.3',
        severity: 'warn',
        message: `${count} elements carry data-wc-error="${name}"; only the first is ever written to.`,
        count,
      });
    }
  }

  // §1.5 — at most one [data-wc-submit] / [data-wc-wallet]; a second gets no
  // handler at all.
  for (const attr of ['data-wc-submit', 'data-wc-wallet'] as const) {
    const hits = all(root, `[${attr}]`);
    if (hits.length <= 1) continue;
    if (repair) {
      for (const el of hits.slice(1)) el.removeAttribute(attr);
      repairs.push(`§1.5 kept the first [${attr}] and unwrapped ${hits.length - 1} duplicate(s)`);
    } else {
      issues.push({
        rule: '§1.5',
        severity: 'fatal',
        message: `${hits.length} [${attr}] elements; every one after the first gets no handler.`,
        count: hits.length,
      });
    }
  }

  for (const el of all(root, '[data-wc-submit]')) {
    if (el.getAttribute('id')) {
      if (repair) {
        el.removeAttribute('id');
        repairs.push('§1.5 removed the id from [data-wc-submit] (the runtime renames it to wc-submit at mount)');
      } else {
        issues.push({
          rule: '§1.5',
          severity: 'warn',
          message: 'The pay button has an id. The runtime renames it to wc-submit at mount, so the id is gone from the saved document.',
        });
      }
    }
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tagOf(el) === 'BUTTON' && type !== 'button') {
      if (repair) {
        el.setAttribute('type', 'button');
        repairs.push('§1.5 set type="button" on the pay button');
      } else {
        issues.push({
          rule: '§1.5',
          severity: 'fatal',
          message: 'The pay button has no type="button"; inside any form-like context it submits and reloads.',
        });
      }
    }
    const elementChildren = el.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE);
    if (elementChildren.length > 0) {
      issues.push({
        rule: '§1.5',
        severity: 'warn',
        message:
          'The pay button contains markup. At mount the runtime reassigns its textContent, ' +
          'destroying any icon or sub-label inside it — make those siblings.',
      });
    }
  }

  // §4.3 — an inline layout `display:` on a runtime-toggled element is wiped
  // by the reveal; ship hidden with style="display:none" and put layout in a class.
  for (const attr of RUNTIME_TOGGLED_ATTRS) {
    for (const el of all(root, `[${attr}]`)) {
      const style = el.getAttribute('style') || '';
      const m = style.match(/(^|;)\s*display\s*:\s*([^;]+)/i);
      if (!m) continue;
      const value = m[2].trim().toLowerCase();
      if (value === 'none') continue;
      if (repair) {
        const cleaned = style.replace(/(^|;)\s*display\s*:\s*[^;]+;?/gi, '$1').replace(/^;+|;+$/g, '').trim();
        if (cleaned) el.setAttribute('style', cleaned);
        else el.removeAttribute('style');
        repairs.push(`§4.3 removed an inline display: on [${attr}] (the runtime's reveal wipes it)`);
      } else {
        issues.push({
          rule: '§4.3',
          severity: 'warn',
          message: `[${attr}] carries an inline display: ${value} for layout; the runtime's reveal wipes it.`,
        });
      }
    }
  }

  // §4.4 — <template> is the blueprint and the runtime stamps it once per
  // thing the funnel sells.
  for (const container of all(root, '[data-wc-options]')) {
    const tpl = container.querySelector('template[data-wc-option-item]');
    if (!tpl) {
      issues.push({
        rule: '§4.4',
        severity: 'fatal',
        message:
          '[data-wc-options] has no <template data-wc-option-item>. The runtime has no blueprint ' +
          'to stamp, so the picker renders zero cards.',
      });
      continue;
    }
    const roots = tpl.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[];
    if (roots.length !== 1) {
      issues.push({
        rule: '§4.4',
        severity: 'fatal',
        message: `The option <template> has ${roots.length} root elements; it needs exactly one.`,
        count: roots.length,
      });
    }
    const badRoot = roots.find((r) => ['TR', 'TD', 'TBODY', 'OPTION'].includes(tagOf(r)));
    if (badRoot) {
      issues.push({
        rule: '§4.4',
        severity: 'fatal',
        message: `The option <template> root is a <${tagOf(badRoot).toLowerCase()}>. It is dropped when parsed inside a <div>, so the picker renders zero cards.`,
      });
    }
    // `for=` binds every clone to card 1's input; `name=` groups every clone
    // natively and unchecks the main product.
    for (const el of all(tpl, '[id]')) {
      if (repair) {
        el.removeAttribute('id');
        repairs.push('§4.4 removed an id from inside the option <template> (every clone would share it)');
      } else {
        issues.push({ rule: '§4.4', severity: 'fatal', message: 'An element inside the option <template> has an id; every stamped clone would share it.' });
      }
    }
    for (const el of all(tpl, 'label[for]')) {
      if (repair) {
        el.removeAttribute('for');
        repairs.push('§4.4 removed a <label for> inside the option <template> (it binds every clone to card 1)');
      } else {
        issues.push({ rule: '§4.4', severity: 'fatal', message: '<label for> inside the option <template> binds every clone to card 1\'s input.' });
      }
    }
    for (const el of all(tpl, 'input[name], select[name]')) {
      if (repair) {
        el.removeAttribute('name');
        repairs.push('§4.4 removed a name= inside the option <template> (it groups every clone natively and unchecks the main product)');
      } else {
        issues.push({ rule: '§4.4', severity: 'fatal', message: 'A name= inside the option <template> groups every clone natively and unchecks the main product.' });
      }
    }
    const toggles = all(tpl, 'input[type="checkbox"], input[type="radio"]');
    if (toggles.length > 1) {
      issues.push({
        rule: '§4.4',
        severity: 'warn',
        message: `The option <template> has ${toggles.length} checkboxes/radios; at most one is allowed.`,
        count: toggles.length,
      });
    }
  }

  // §5.2 — every data-wc-bind value must be on the §6 list verbatim. An
  // invented key resolves to null and ships the placeholder money.
  for (const el of all(root, '[data-wc-bind]')) {
    const key = (el.getAttribute('data-wc-bind') || '').trim();
    if ((WC_BIND_KEYS as readonly string[]).includes(key)) continue;
    const alias = BIND_KEY_ALIASES[key] || BIND_KEY_ALIASES[key.toLowerCase()];
    if (alias && repair) {
      el.setAttribute('data-wc-bind', alias);
      repairs.push(`§5.2 rewrote data-wc-bind="${key}" to the real key "${alias}"`);
      continue;
    }
    issues.push({
      rule: '§5.2',
      severity: 'fatal',
      message:
        `data-wc-bind="${key}" is not on the §6 list. An invented key resolves to null, which ` +
        'defeats the money guard instead of triggering it — your placeholder ships to the buyer.',
    });
  }

  // §4.6 — the embed mounts at boot, so on a later step it is built inside a
  // hidden subtree and the ~12s wait for its iframe expires on screen one.
  const steps = all(root, '[data-wc-step]');
  if (steps.length > 1) {
    const first = steps[0];
    for (const [label, sel] of [
      ['[data-wc-payment]', '[data-wc-payment]'],
      ['[data-wc-field="email"]', '[data-wc-field="email"]'],
      ['[data-wc-submit]', '[data-wc-submit]'],
    ] as const) {
      const el = all(root, sel)[0];
      if (!el) continue;
      if (el !== first && !isAncestor(first, el)) {
        issues.push({
          rule: '§4.6',
          severity: 'fatal',
          message: `${label} is not in the FIRST [data-wc-step]. The embed mounts at boot inside a hidden subtree and every pay click is swallowed.`,
        });
      }
    }
  }

  // §5.1 — no price, total, currency or order value as literal text outside a
  // data-wc-bind element. Reported, never auto-repaired: which number is the
  // price is a judgement call, and that is the AI pass's job.
  const money = findLiteralMoney(root);
  if (money.length) {
    issues.push({
      rule: '§5.1',
      severity: 'fatal',
      message:
        `${money.length} literal money string(s) outside a data-wc-bind element ` +
        `(e.g. ${money.slice(0, 3).map((m) => JSON.stringify(m)).join(', ')}). ` +
        'The funnel supplies every price at render time; hardcoded money ships the wrong number.',
      count: money.length,
    });
  }

  return root.toString();
}

// The currency code alternatives are word-bounded on purpose: without it
// "12 eurostar tickets" reads as a price and every such page reports a §5.1
// the AI pass then has to reason about.
const MONEY_RE =
  /(?:[$€£¥]\s?\d[\d.,]*)|(?:\d[\d.,]*\s?(?:[$€£¥]|\b(?:USD|EUR|GBP)\b))/i;

/** Text nodes holding money that no data-wc-bind ancestor explains (§5.1). */
export function findLiteralMoney(root: HTMLElement): string[] {
  const out: string[] = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

  const walk = (node: Node, bound: boolean): void => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      if (bound) return;
      const text = String(node.rawText || '').trim();
      if (!text) return;
      const m = text.match(MONEY_RE);
      if (m) out.push(text.length > 60 ? `${text.slice(0, 60)}…` : text);
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (skip.has(tagOf(el))) return;
    const nowBound = bound || el.getAttribute('data-wc-bind') != null;
    for (const child of el.childNodes) walk(child, nowBound);
  };

  walk(root, false);
  return out;
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * The text-level half of the repair on its own: remove every `<base>` and
 * every `<script src>` / preload `<link>` naming a CRM runtime file, comments
 * included.
 *
 * For FRAGMENTS — an element the AI editor just rewrote — where the
 * whole-page rules (one payment mount, one email field) do not apply but this
 * one still does. It is the exact regression that broke a live checkout: the
 * model hand-wrote `<script src="/js/wasabi-checkout.js">`, and because
 * ensureScript() matches the raw text, that suppressed the server's own
 * injection and the page could never start a checkout.
 */
export function stripRuntimeConflicts(html: string): { html: string; repairs: string[] } {
  const repairs: string[] = [];
  return { html: repairText(html, repairs), repairs };
}

/** Everything wrong with `html`, changing nothing. */
export function auditWasabiCheckout(html: string): ContractIssue[] {
  const issues: ContractIssue[] = [];
  auditText(html, issues);
  domPass(html, { repair: false, scaffold: false }, [], issues);
  return issues;
}

/**
 * Fix every violation a machine can fix on its own, then audit what is left.
 *
 * `scaffold` (default false) additionally inserts a payment mount and an email
 * field when they are absent. The conversion pipeline turns it on so a page
 * always comes out able to charge; the editor's post-edit repair leaves it off
 * so it never injects controls into a page the user is mid-design on.
 */
export function repairWasabiCheckout(
  html: string,
  opts: { scaffold?: boolean } = {},
): RepairResult {
  const repairs: string[] = [];
  const scaffold = opts.scaffold === true;
  let out = repairText(html, repairs);

  // Twice, deliberately. Claiming the page's CTA as [data-wc-submit] and
  // scaffolding the payment mount both CREATE work for later rules (the CTA
  // now sits in a <form> that has to become a <div>; the mount is now the
  // anchor the email field goes in front of). Every repair is idempotent, so
  // a second settling pass costs one parse and closes that gap.
  out = domPass(out, { repair: true, scaffold }, repairs, []);
  out = domPass(out, { repair: true, scaffold }, repairs, []);

  // Audit the REPAIRED output, so the caller sees the real remaining work
  // rather than the issues we just fixed.
  const issues = auditWasabiCheckout(out);
  return { html: out, repairs, issues };
}
