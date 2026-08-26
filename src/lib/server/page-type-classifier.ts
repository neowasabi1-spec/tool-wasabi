/**
 * Heuristic page-type classifier for competitor funnel steps.
 *
 * The extension's funnel walk historically saved every step as page_type
 * 'landing', dumping checkouts, upsells and thank-you pages into the
 * "Landing Page" folder of Templates → Pages. This classifier infers the
 * real type from the URL, the title and the captured HTML so each step
 * lands in the right folder (advertorial → Advertorial, checkout →
 * Checkout, upsell → Upsell N, and so on).
 *
 * Values must stay in sync with BUILT_IN_PAGE_TYPE_OPTIONS in src/types.
 */

export interface ClassifyInput {
  url?: string;
  title?: string;
  name?: string;
  html?: string;
  /** How many upsell steps were already seen in this funnel (for the
   *  upsell_1 / upsell_2 / upsell_3 numbering). */
  upsellsSeen?: number;
  /** Same for downsells. */
  downsellsSeen?: number;
}

const cap = (n: number, max: number) => Math.min(Math.max(n, 1), max);

/** Strip tags and collapse whitespace so text regexes work on prose. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function inferPageType(input: ClassifyInput): string {
  const url = (input.url || '').toLowerCase();
  let path = url;
  try {
    path = new URL(input.url || '').pathname.toLowerCase();
  } catch {
    /* keep full url as path fallback */
  }
  const title = `${input.title || ''} ${input.name || ''}`.toLowerCase();
  // 300 KB of markup is plenty for signal words and keeps regexes cheap.
  const html = (input.html || '').slice(0, 300_000);
  const text = html ? htmlToText(html).slice(0, 60_000) : '';
  const upsellsSeen = input.upsellsSeen ?? 0;
  const downsellsSeen = input.downsellsSeen ?? 0;

  // ── Post-purchase offers (check BEFORE thank-you/checkout: these pages
  //    often mention "order" too, but their wording is unmistakable). ──
  const upsellPath = /\/(upsell|oto\d*|one[-_]?time|special[-_]?offer|post[-_]?purchase|upgrade|addon|bump)(\/|$|[-_?.])/;
  const upsellText = /(your order (is|'s) not complete|order not complete|do not close this (window|page)|one[- ]time offer|add (this )?to (my|your) order|upgrade your order|wait[!¡].{0,80}(order|offer)|exclusive one[- ]time)/;
  if (upsellPath.test(path) || upsellText.test(text) || upsellText.test(title)) {
    return `upsell_${cap(upsellsSeen + 1, 3)}`;
  }
  const downsellPath = /\/(downsell|ds\d+)(\/|$|[-_?.])/;
  const downsellText = /(last chance|before you go.{0,60}(offer|discount)|final offer|are you sure.{0,40}(deal|offer))/;
  if (downsellPath.test(path) || downsellText.test(text)) {
    return `downsell_${cap(downsellsSeen + 1, 3)}`;
  }

  // ── Thank-you / order confirmation ──
  const thankPath = /\/(thank[-_]?you|thanks|confirmation|order[-_]?(received|confirmed)|receipt|success)(\/|$|[-_?.])/;
  const thankText = /(thank you for (your|the) (order|purchase)|your order (is|has been) confirmed|order confirmation|your receipt|purchase complete)/;
  if (thankPath.test(path) || thankText.test(text) || /thank you/.test(title)) {
    return 'thank_you';
  }

  // ── Checkout ──
  const checkoutPath = /\/(checkout|checkouts|cart|payment|secure[-_]?order|order[-_]?form|buy[-_]?now)(\/|$|[-_?.])/;
  const checkoutHtml = /(autocomplete=["']cc-(number|exp|csc)|name=["']card[_-]?number|credit card number|card details|cvv|cvc)/i;
  const checkoutText = /(order summary|shipping (address|information).{0,400}(payment|card)|billing (address|details))/;
  if (checkoutPath.test(path) || (html && checkoutHtml.test(html) && checkoutText.test(text))) {
    return 'checkout';
  }

  // ── Quiz / survey ──
  const quizPath = /\/(quiz|survey|assessment)(\/|$|[-_?.])/;
  const quizText = /(take (the|this|our) (quick )?(quiz|survey)|question 1 (of|\/)|start (the )?quiz)/;
  if (quizPath.test(path) || quizText.test(text) || /\bquiz\b/.test(title)) {
    return 'quiz';
  }

  // ── Advertorial / article-style presell ──
  const advPath = /\/(news|article|articles|story|stories|blog|report|advertorial|editorial|breaking)(\/|$|[-_?.])/;
  const advText = /(advertorial|sponsored (content|article|post)|this is an advertisement|written by [a-z]|medically reviewed by)/;
  if (advPath.test(path) || advText.test(text)) {
    return 'advertorial';
  }

  // ── VSL (video sales letter): a page whose hero is a video ──
  const vslPath = /\/(vsl|video|watch|presentation)(\/|$|[-_?.])/;
  const vslText = /(watch (this|the) (short |free )?(video|presentation)|video reveals|turn (your |the )?sound on)/;
  if (vslPath.test(path) || vslText.test(text)) {
    return 'vsl';
  }

  // ── Product page (Shopify-style PDP) ──
  const productPath = /\/(products?|item|shop)\/[a-z0-9-]/;
  if (productPath.test(path)) {
    return 'product_page';
  }

  return 'landing';
}

/** Is this type one of the numbered upsell values? */
export const isUpsellType = (t: string) => /^upsell_\d$/.test(t);
export const isDownsellType = (t: string) => /^downsell_\d$/.test(t);
