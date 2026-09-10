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

/**
 * Derived from the WasabiCRM source itself (public/js/wasabi-checkout.js and
 * src/server/modules/pages/pages.render.ts), not from a hand-written doc.
 *
 * The previous version of this text described the checkout as a self-contained
 * document whose HTML "contains NO payment logic". That is what broke a live
 * page: the HTML is a FRAGMENT that only works as the return value of
 * renderCheckoutPage() served from the CRM's own origin, because every call the
 * runtime makes is a same-origin relative path. A page built to the old rules
 * carried every data-wc-* attribute they listed and still could not start a
 * checkout — it hand-wrote a <script src=".../wasabi-checkout.js">, which
 * suppressed the server's own injection.
 *
 * Rules are phrased as properties of the OUTPUT, not as a diff, because this
 * text is also used for from-scratch generation (landing/swipe,
 * funnel-swap-proxy) where "never remove the script" reads as licence to add
 * one.
 */
export const WASABI_CHECKOUT_RULES = `=== WASABICRM CHECKOUT — BINDING RULES ===
These rules describe the page you are working on. They OVERRIDE any instruction
above that conflicts with them. Breaking one breaks live card payments.

You are writing or editing the HTML of a **WasabiCRM checkout page**, which takes real card payments through Whop. These rules override any conflicting instruction above, in both edit and from-scratch mode, and none licenses you to *add* machinery that was absent.

## 0. Your HTML is a fragment the CRM serves. Read this first.

It becomes a live checkout only as the return value of \`renderCheckoutPage()\` (\`pages.render.ts\`), served **from the CRM's own origin**. At request time \`decorate()\` injects (never hand-write any of it) \`window.__WASABI__\` (the funnel prices), the step stylesheet, the money guard, and before \`</body>\` \`/js/wasabi-page.js\`, Whop's \`.../checkout/loader.js\`, \`/js/whop-submit-button.js\`, \`/js/wasabi-checkout.js\`, and \`/js/wasabi-editor.js\` in the editor. Every runtime call is a **same-origin relative path**, so opened as a file or hosted elsewhere the page paints and charges nothing.

- **Never assign \`window.__WASABI__\`**; reading it is fine, printing money out of it is not.
- **Never write a \`<script src>\` or preload \`<link>\` for anything above, and never rewrite an \`/api/\` or \`/js/\` path to an absolute URL.** A missing runtime self-heals; a present one does not (§1.4).
- **Never write a \`<base>\` tag at all.** It re-roots every relative URL against \`document.baseURI\`, so the injected \`/js/\` runtimes 404 and \`/api/payments/checkout/funnel/init\` never answers.
- Emit a fragment; \`<html>\`/\`<head>\`/\`<body>\` optional but well-formed.
- The legacy static templates (\`public/checkout-*.html\`) have no \`data-wc-*\` and drive \`data-whop-checkout-*\` from their own script. These rules do not apply to one; say so rather than converting it.

## 1. What must be true for the page to charge at all

Every failure here is silent: the page paints, looks finished, takes no money.

**1.1 — Exactly one \`[data-wc-payment]\`, left empty. Never delete, hide or nest one.** It is the only element the runtime requires, and the only surface errors print to. Its \`innerHTML\` is wiped at mount: design around it. Any \`id\` but §1.6's survives, so \`id="pay"\` is the usual scroll anchor.

**1.2 — Exactly one \`[data-wc-field="email"]\`. It is required.** Whop's own email box is hidden unconditionally and this is the only email it ever receives. Omitting it does not block the sale: the buyer is charged and the order lands with no email.

**1.3 — One element per \`data-wc-field\` and per \`data-wc-error\` value.** Both are \`querySelector\`, so a duplicated field leaves the buyer typing into a copy the runtime never reads; use CSS for responsive layout. Names, exact camelCase: \`email\`, \`firstName\`, \`lastName\`, \`phone\`. **Each \`data-wc-field\` sits on an \`<input>\`, \`<select>\` or \`<textarea>\`** — the runtime reads \`.value\`, so on a \`<div>\` it reads empty forever and the pay button stays locked.

**1.4 — No \`<script src>\` TEXT in your output may end with a runtime filename.** \`ensureScript()\` (\`pages.render.ts:421-431\`) decides whether to inject one by matching the filename against the **raw HTML text**, not the DOM. It is unanchored and blind to comments: I ran it, and \`<!-- <script src="/js/old-loader.js"></script> -->\` returns true, suppressing it.

> **The sequence \`<script … src="…X"\` must not appear anywhere in the TEXT of your output, comments and \`<noscript>\` included, where X is \`loader.js\`, \`wasabi-checkout.js\`, \`wasabi-page.js\`, \`whop-submit-button.js\` or \`wasabi-editor.js\`.** Delete such tags, never comment one out, rename your own files. The head/body injectors are textual too, patching the first \`<head\` or \`</body>\` in the string.

**1.5 — At most one \`[data-wc-submit]\`: text only inside it, no \`id\`, \`type="button"\`.** A second gets no handler; repeat a CTA as a scroll link. Omitting it is safe: the runtime mints one under the embed. At mount the runtime reassigns the button's \`textContent\`, destroying any icon or sub-label inside it: make those siblings. The runtime renames it to \`wc-submit\` at mount, so your id is gone from the saved document and every unlock before mount — and in the editor preview — misses it. At most one \`[data-wc-wallet]\` likewise.

**1.6 — Never take the runtime's names.** Ids \`wc-payment\`, \`wc-submit\`, \`wc-sub-modal\`, \`wc-sub-embed\`, \`wc-sub-express\`, \`wc-sub-submit\`, \`wc-payment-host\`: the first six resolve globally, so a duplicate steals the embed's identity. Globals \`__WASABI__\`, \`wco\`, \`WasabiCheckout\`, \`WasabiPage\`, \`WasabiWhopButton\`, \`__wcCheckoutComplete\`, \`__wcPaymentError\`, \`__wcSubscription*\`. **Never dispatch a bubbling \`complete\` on \`document\`**: the runtime reads it as a finished purchase and fires the postback and upsell chain.

## 2. Authored \`<script>\` is allowed

Nothing is injected into a checkout except the §0 runtimes, so a top-of-funnel pixel has no other home: do not refuse one. Two further bans: **no purchase/conversion event** (they fire server-side on \`/checkout/complete\`, so one here double-counts and credits buyers who never paid), and **no writing money or \`data-wc-priced\`**.

## 3. Machine state in your input is not markup to preserve

Strip \`data-wc-priced\`, \`data-wc-js\` and \`data-wc-steps-ready\` from \`<html>\`, plus every \`data-wasabi-injected\` node and every \`data-wc-step-active\`. The save path strips every other tell but never \`data-wc-priced\`, which permanently defeats the money guard and ships the designer's fake \`$49.00\`. Author no runtime-stamped attribute or class (\`data-wc-option\`, \`data-wc-option-kind\`, \`data-wc-required\`, \`data-wc-unavailable\`, \`data-wc-authored\`, \`data-wc-display0\`, \`is-selected\`, \`aria-checked\`, \`aria-disabled\` — but **not** \`data-wc-options\` / \`-option-item\` / \`-exclusive\`, which you author; every other \`aria-*\` and \`role\` is yours, §7) — **but keep the CSS targeting them**, and the \`.wc-option*\`, \`.wc-bump*\`, \`.wc-preview-*\` rules, dead-looking because the runtime makes those nodes at render time.

## 4. Structure

**4.1 — Never remove or rename a \`data-wc-*\` attribute on an element you keep.** Spelling is exact, lookups are by attribute not position, and **moving an element is keeping it**. Deleting a whole optional section is different, and allowed (§7). Mount points stay empty; \`<template>\` content is invisible to \`querySelector\`.

**4.2 — \`[data-wc-loading]\` must not be a descendant of \`[data-wc-payment]\`, and sits on a node whose only content is that text**: put any spinner beside it, not inside it. The host is emptied at mount, and at ~12 s the runtime overwrites \`textContent\` on every match. If the input has one inside: **move** it, don't delete it.

**4.3 — Never hide a runtime-toggled element with a CSS rule, and never give one an inline \`display:\` for layout.** Toggled: \`[data-wc-options]\`, \`-bumps\`, \`-error\`, \`-when\`, \`-loading\`, \`-hide-until-ready\`, \`-step\`, \`-step-back\`, \`-submit\`. A rule beats the reveal; an inline layout \`display\` is wiped by it. Put layout in a class, ship hidden with \`style="display:none"\`. **Never put \`[data-wc-hide-until-ready]\` on or around \`[data-wc-payment]\`, \`[data-wc-wallet]\`, the price or the pay button**: it is never revealed on the failure path, so the error stays invisible. Buyer fields go in bare inputs: nothing listens for \`submit\`, so Enter or a \`type="submit"\` control reloads the page and discards the mounted session.

**4.4 — \`<template>\` is the blueprint; the card count is the funnel's decision.** The runtime stamps the \`<template data-wc-option-item>\` inside \`[data-wc-options]\` once per thing the funnel sells, so **never hand-place a product or package card** and **never delete a \`<template>\` from a container you keep**. Cards are direct children: put grid or flex on the container. Inside a template:
- **One root element, parsable inside a \`<div>\`**: a \`<tr>\`, \`<td>\` or \`<tbody>\` root is dropped by the parser and renders **zero cards**; an \`<option>\` root parses but is not a card.
- **No \`id=\`, so no \`<label for=…>\`**: \`for\` binds every clone to card 1's input; use a bare \`<label>\` wrapper.
- **No \`name=\`** on a radio or checkbox: it groups every clone natively and unchecks the main product.
- **At most one checkbox/radio, nothing else interactive but \`<a>\`**: any other click toggles the card.

**4.5 — Navigation: \`data-wc-step-next\` only, never \`data-wc-next\`.** On a checkout the next URL is \`/checkout/complete\`, and step navigation falls through to it when there is no further screen, including when the page has no \`[data-wc-step]\`. With no \`?order=\` it renders a fake "✅ Payment confirmed" **and fires every purchase pixel**. So never author \`data-wc-next\` here, and put \`data-wc-step-next\` only on a screen with another \`[data-wc-step]\` after it. Steps must be siblings in numeric = document order.

**4.6 — \`[data-wc-payment]\`, \`[data-wc-field="email"]\` and the pay button all go in the FIRST step.** The embed mounts at boot, so on a later step it is built inside a hidden subtree (§4.3's deadlock) and the ~12 s wait for its iframe expires while the buyer is on screen one, after which every pay click is swallowed. If payment cannot go there, use one screen with no \`[data-wc-step]\`.

## 5. Money, copy and claims

**5.1 — No price, total, currency code or symbol, billing term, product name or order value may appear as literal text outside a \`data-wc-bind\` element.**

**5.2 — A wrong binding key defeats the money guard instead of triggering it.** A stylesheet hides any binding whose value ends in \`price\`, \`priceRaw\`, \`total\`, \`renewal\` or \`terms\` until the runtime sets \`data-wc-priced\` on \`<html>\`, and a 10-second failsafe em-dashes any key whose last segment is one of those or \`subtotal\`. So a **real** money key is safe (a \`$49.00\` placeholder inside one is expected), while an **invented** key resolves to null and ships your placeholder. **Every \`data-wc-bind\` value must be on the §6 list verbatim**; there is no \`*.renewal\` key, the billing line is \`option.terms\`. \`currency\` is guarded by neither, so omit currency labels or ship that element empty. The runtime writes no \`content=\` or \`aria-*\`: **no prices in structured data**.

**5.3 — Ship no claim the funnel cannot back.** Nothing hides or blanks a non-money binding, so placeholder copy in \`product.*\`, \`option.*\` and \`brand.name\` must be generic and claim-free, and every bound \`<img>\` needs a neutral inline-SVG placeholder \`src\`. No struck-through was-price, no "SAVE 60%", no countdown tied to a price: the funnel supplies a price, never a was-price. **\`option.index\` is the card's POSITION, not a quantity.** Review counts in the builtin templates are editable copy: keep them and their slugs, invent none, inflate none.

## 6. Attribute reference

| Attribute | How many | Notes |
|---|---|---|
| \`data-wc-payment\` | exactly one | Embed mount, wiped at mount; the only error surface (§1.1) |
| \`data-wc-field\` | one per name | \`email\`, \`firstName\`, \`lastName\`, \`phone\` (§1.2–1.3) |
| \`data-wc-submit\` / \`-wallet\` | at most one each | Pay button (§1.5); wallet slot, wiped at mount |
| \`data-wc-options\` / \`-option-item\` | all / first \`<template>\` in each | One card per option, and its blueprint (§4.4) |
| \`data-wc-when\` | in option cards and summary rows | Tokens from \`main bump renewal one_time required\`; any unknown token (a pipe, \`one-time\`) hides the node forever; inert in legacy bump cards, so it hides nothing there — leave it, and do not rely on it |
| \`data-wc-summary\`/\`-summary-item\`, \`-exclusive\`, \`-error\`, \`-loading\`, \`-hide-until-ready\`, \`-text\`, \`-media\`, \`-step*\`, \`-countdown\`, \`-year\`, \`-package-group\`, \`-bumps\`, \`-bump*\` | — | All live; preserve them. Dropping \`-package-group\` is an **overcharge** |

**\`data-wc-bind\` keys — the whole list.** Page scope: \`product.name\`, \`product.description\`, \`product.price\`, \`product.priceRaw\`, \`product.image\`, \`total\`, \`subtotal\`, \`currency\`, \`brand.name\`, \`brand.logo\`, \`brand.support\`. Card scope: \`option.name\`, \`option.description\`, \`option.price\`, \`option.priceRaw\`, \`option.image\`, \`option.terms\`, \`option.index\`, \`option.total\`, plus \`bump.name\`, \`bump.description\`, \`bump.price\`, \`bump.priceRaw\`. Either family resolves in either card type; prefer \`option.*\`. The runtime writes by tag: image bindings on \`<img>\`, \`brand.support\` on \`<a>\`.

**\`option.price\` vs \`option.total\`.** A bump's \`price\` is the amount *on top of* the main product, not the pack price: in an **exclusive** picker (\`data-wc-exclusive\`, or an ancestor \`[data-wc-package-group]\`) bind \`option.total\`; in an **additive** picker and in every **summary row** bind \`option.price\`, or the rows stop summing to \`total\`.

## 7. What you may change, and what to repair

Layout, CSS, copy, imagery, section order, responsiveness, accessibility and authored \`<script>\` are yours, and **deleting a whole optional section is allowed** (picker, bump block, reviews), container and \`<template>\` together: *"a page with only \`[data-wc-payment]\` is a working checkout"* — true of the runtime, but this ruleset also requires the one email field (§1.2). Never deleted: those two.

**When the input already breaks a rule, repair wins over preservation**, and §8 runs against the repaired output, one way only: never drop an attribute, a \`<template>\` or a section merely to make a check pass. **Move**, do not delete, whatever a rule says to move; otherwise strip just the offending attribute or id, and on a duplicated field/error/submit/wallet attribute keep the one the buyer reaches first. **Say what you repaired**, with the rule number.

## 8. Check your output before you answer

If a check fails, fix it. If the request cannot be met without breaking a rule, say so and name the rule.

- [ ] One \`[data-wc-payment]\`, empty; one \`[data-wc-field="email"]\`; one element per field and per error name (§1).
- [ ] No \`<script … src="…">\` **text** in my output (comments and \`<noscript>\` included) ends with any of the five runtime filenames; I read the tail of every src, and deleted rather than commented out script tags; no \`<base>\` tag anywhere (§0, §1.4).
- [ ] At most one \`[data-wc-submit]\` (\`type="button"\`, no id, text only) and one \`[data-wc-wallet]\`; no reserved id, no shadowed global, no \`complete\` on \`document\`, no purchase pixel, no \`__WASABI__\` assignment (§1.5–1.6, §2).
- [ ] \`<html>\` clean of runtime state, its CSS kept, every \`data-wc-*\` I kept still on its element bar repairs I named (§3, §4.1, §7).
- [ ] §4 obeyed: loading-node placement, nothing hidden that the runtime must reveal, no submittable form, no hand-placed card, every \`<template>\` legal, no \`data-wc-next\`, payment + email + button on step one.
- [ ] §5 obeyed: every \`data-wc-bind\` on the §6 list verbatim, no literal money or product text, no price in structured data, \`option.total\` in exclusive pickers and \`option.price\` elsewhere, generic placeholder copy, no invented claim.

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
