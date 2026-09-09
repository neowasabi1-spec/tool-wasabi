// Checkout mode — "standard" vs "WasabiCRM".
//
// A funnel step whose page type is Checkout can be built two ways:
//
//   standard (default) — nothing changes anywhere. Every AI path builds the
//                        exact same prompt it built before this option existed.
//   wasabi             — the page is a WasabiCRM checkout: real card payments
//                        go through Whop, and ALL the payment logic lives in an
//                        external runtime (`/js/wasabi-checkout.js`) that binds
//                        to `data-wc-*` attributes at page load. Any model that
//                        rewrites or edits that HTML has to be told the rules
//                        below, or it silently breaks payment (dropped
//                        attributes, deleted <template>, duplicated <script>).
//
// This module is the single source of truth for the rules text. Consumers:
//   - /api/ai-edit-html       full-page AI edit in the Visual HTML Editor
//   - /api/ai-edit-element    element-level AI edit in the same editor
//   - /api/funnel-swap-proxy  copy rewrite → Supabase Edge `funnel-swap-v1`
//   - /api/landing/swipe      direct Claude swipe
//   - openclaw-worker.js      Neo/Morfeo local rewrite — gets the RESOLVED text
//                             in the job payload, so there is no second copy of
//                             the rules to keep in sync.

export type CheckoutMode = 'standard' | 'wasabi';

/** Anything unset/unknown resolves to this — i.e. pre-existing behaviour. */
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'standard';

export const CHECKOUT_MODE_OPTIONS: {
  value: CheckoutMode;
  label: string;
  /** Compact label for table cells / toolbars. */
  shortLabel: string;
  description: string;
}[] = [
  {
    value: 'standard',
    label: 'Standard checkout',
    shortLabel: 'Standard',
    description: 'Normal checkout page. The AI treats it like any other page.',
  },
  {
    value: 'wasabi',
    label: 'WasabiCRM checkout',
    shortLabel: 'WasabiCRM',
    description:
      'Whop payments via the wasabi-checkout.js runtime. Every AI rewrite/edit of this page gets the data-wc-* / <template> / <script> rules so it cannot break payment.',
  },
];

export function checkoutModeOption(mode: CheckoutMode | string | null | undefined) {
  const value = normalizeCheckoutMode(mode);
  return CHECKOUT_MODE_OPTIONS.find((o) => o.value === value) ?? CHECKOUT_MODE_OPTIONS[0];
}

export function normalizeCheckoutMode(raw: unknown): CheckoutMode {
  return String(raw ?? '').trim().toLowerCase() === 'wasabi' ? 'wasabi' : DEFAULT_CHECKOUT_MODE;
}

/** True for the page types that actually render a checkout / order form. */
export function isCheckoutPageType(pageType: string | null | undefined): boolean {
  const t = String(pageType ?? '').trim().toLowerCase();
  if (!t) return false;
  return /^(checkout|checkout_page|checkout-page|order|order_form|orderform)$/.test(t) || t.includes('checkout');
}

/** The verbatim ruleset, kept in sync with the operator-facing prompt doc. */
export const WASABI_CHECKOUT_RULES = `=== WASABICRM CHECKOUT — BINDING RULES ===
These rules describe the page you are working on. They OVERRIDE any instruction
above that conflicts with them. Breaking one breaks live card payments.

You are editing the HTML of "Checkout", a page in a live sales funnel.
Read these rules before you change anything, and follow them exactly.

## What this page is

This is a live CHECKOUT page. It takes real card payments through Whop. Its
HTML contains NO payment logic — all of it lives in an external runtime,
\`/js/wasabi-checkout.js\`, which finds elements by their \`data-wc-*\`
attributes and fills them in at page load. The markup is a shell the runtime
writes into.

## Hard constraints — breaking any of these breaks payment

1. NEVER add, remove, edit or reorder any \`<script>\` tag. The runtime is
   injected by the server; a page that loads it twice creates two orders per
   visitor, and a page that drops it cannot charge at all.

2. NEVER remove or rename a \`data-wc-*\` attribute. Restyle, move, rewrap or
   re-nest the element freely — the runtime looks these up by attribute, not by
   position, class or tag — but the attribute itself must survive.

3. NEVER write a price, product name, currency or billing term as literal text
   in a place that carries \`data-wc-bind\`. Those values come from the funnel
   at runtime and differ per funnel. Placeholder text INSIDE a bound element is
   fine and expected — it is what the operator sees while editing — but it must
   stay inside the bound element, never replace it.

4. NEVER change the NUMBER of product cards. \`[data-wc-options]\` holds exactly
   one \`<template data-wc-option-item>\`, and the runtime stamps it once per
   product the funnel sells. One product means one card, five means five.
   Hand-placing three "package" cards produces a page that shows the wrong
   products to every funnel that does not happen to sell exactly three.

5. NEVER delete a \`<template>\` element. They look like dead markup and are not:
   they are the blueprints the runtime clones. Removing one leaves an empty
   container forever.

6. Do NOT invent claims the funnel cannot back — struck-through "was" prices,
   "SAVE 60%", fake review counts, countdown timers tied to a discount. There is
   no discount data behind them.

## The attributes and what each one is for

\`\`\`
data-wc-payment          mount point for the Whop card form. REQUIRED.
data-wc-submit           the pay button. The runtime owns its label and its
                         enabled/disabled state. REQUIRED.
data-wc-loading          shown until the payment form is ready, then hidden
data-wc-wallet           optional mount point for Apple Pay / Google Pay
data-wc-field="email"    buyer inputs. Also: firstName, lastName, phone.
                         email + firstName + lastName gate the pay button.
data-wc-error="email"    shown when that field is invalid

data-wc-options          container for the product cards
  <template data-wc-option-item>   cloned once per product
data-wc-exclusive        on the container: cards are ALTERNATIVES (1x/2x/3x)
data-wc-summary          order summary container
  <template data-wc-summary-item>  cloned once per selected product

data-wc-bind="..."       filled in at runtime. Valid keys:
                           product.name  product.description  product.price
                           product.image  total  subtotal  currency
                           brand.name  brand.logo  brand.support
                         Inside an option card or summary row:
                           option.name  option.description  option.price
                           option.total  option.image  option.terms
                           option.index
                         option.price is that product's own price;
                         option.total is what the buyer pays if they pick it.

data-wc-when="main|bump|renewal|one_time|required"
                         inside a card: show this node only for options it
                         applies to
data-wc-media="..."      marks an image an operator can swap from the media
                         library. Keep it on any <img> you add.
\`\`\`

## What you MAY change freely

Everything else. Layout, CSS, copy, colours, fonts, section order, adding or
removing whole sections, responsive behaviour, accessibility. Restructure the
document as much as the design needs — as long as every rule above still holds
in your output.

## Before you answer, check your own output

- [ ] Every \`data-wc-*\` attribute in the original still exists somewhere in
      my output, spelled identically.
- [ ] Every \`<template>\` element in the original still exists.
- [ ] I did not add, delete or edit a single \`<script>\` tag.
- [ ] No price, product name, order value or buyer detail is hardcoded where a
      \`data-wc-bind\` should supply it.
- [ ] The number of product cards is still decided by a \`<template>\`, not by
      how many I typed out.

If any check fails, fix it before answering. If a change I asked for cannot be
made without breaking a rule, say so instead of breaking the rule.

=== END WASABICRM CHECKOUT RULES ===`;

/**
 * The text to append to a system prompt for this mode.
 * Returns '' for 'standard' (and for anything unset) so callers that use
 * {@link withCheckoutRules} produce a byte-identical prompt to before.
 */
export function checkoutPromptAddendum(mode: CheckoutMode | string | null | undefined): string {
  return normalizeCheckoutMode(mode) === 'wasabi' ? WASABI_CHECKOUT_RULES : '';
}

/** Append the rules to an existing system prompt. No-op unless mode = wasabi. */
export function withCheckoutRules(
  systemPrompt: string,
  mode: CheckoutMode | string | null | undefined,
): string {
  const addendum = checkoutPromptAddendum(mode);
  return addendum ? `${systemPrompt}\n\n${addendum}` : systemPrompt;
}
