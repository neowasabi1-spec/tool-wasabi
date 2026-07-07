/**
 * detect-dynamic-scripts — heuristic detector for "functional" client-side
 * scripts, i.e. inline JS that BUILDS visible page content at runtime rather
 * than just tracking/analytics.
 *
 * Why this exists:
 *   The clone/swipe pipeline strips <script> tags by default so the LLM
 *   rewrite is predictable and hydration mismatches can't break the page.
 *   But some landing pages (VSL / live-stream funnels) generate whole
 *   sections purely in JS — fake live chat / comment feeds, viewer
 *   counters, countdowns, FOMO purchase toasts, dynamic offer reveal.
 *   Stripping those leaves empty containers ("Live Chat" card that never
 *   fills). This detector lets the pipeline KEEP scripts automatically for
 *   exactly those pages, without keeping them for plain static pages where
 *   the only scripts are GA / Meta Pixel / GTM.
 *
 * IMPORTANT: keep this logic in sync with src/lib/detect-dynamic-scripts.ts
 * (identical heuristic — one is CommonJS for the worker, the other TS for
 * the Next.js API routes).
 */

// Content words that hint the script renders user-visible sections.
const CONTENT_KEYWORDS =
  /\b(comments?|chat|messages?|reviews?|testimonial|attendees?|viewers?|watching|countdown|live[\s_-]?chat|feed|purchas|checkout\s*bump|just\s*bought|sold|activit|notification|ticker|marquee)\b/i;

// APIs that mutate the DOM to inject content.
const DOM_MUTATION =
  /(\.(innerHTML|outerHTML|textContent|innerText|insertAdjacentHTML)\s*=)|(\.(appendChild|append|prepend|insertBefore|insertAdjacentHTML|insertAdjacentElement|replaceChildren)\s*\()|(document\.createElement\s*\()/;

// Timing / scheduling APIs — content that appears over time.
const TIMING = /\b(setInterval|setTimeout|requestAnimationFrame)\s*\(/;

// Strong single-signal patterns: if any of these appear in inline JS the
// page is almost certainly building content client-side.
const STRONG_PATTERNS = [
  { re: /\b(renderComment|postComment|backfillPastComments|fireCommentsForVideoTime|COMMENT_SCHEDULE|commentSchedule)\b/i, label: 'live-chat comment engine' },
  { re: /getElementById\(\s*['"][^'"]*(comment|chat|message|review|feed|viewer|attendee|countdown|ticker)/i, label: 'JS targets a dynamic-content container (getElementById)' },
  { re: /querySelector(All)?\(\s*['"][^'"]*(comment|chat|message|review|feed|viewer|attendee|countdown|ticker)/i, label: 'JS targets a dynamic-content container (querySelector)' },
  { re: /\b(viewerCount|setViewers|viewerBaseline|watchingCount)\b/i, label: 'live viewer counter' },
  { re: /\b(revealOffer|offerShown|OFFER_REVEAL_SEC)\b/i, label: 'time-based offer reveal' },
];

/**
 * Concatenate the text content of every INLINE <script> (no src attribute).
 * External scripts can't be inspected, so we only look at inline bodies.
 */
function extractInlineScriptText(html) {
  if (!html || typeof html !== 'string') return '';
  const parts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external — skip
    parts.push(m[2] || '');
  }
  return parts.join('\n');
}

/**
 * @param {string} html
 * @returns {{ functional: boolean, signals: string[], inlineScriptCount: number }}
 */
function detectDynamicScripts(html) {
  const signals = [];
  const inlineJs = extractInlineScriptText(html);
  const inlineScriptCount = (html && html.match(/<script\b(?![^>]*\bsrc=)/gi) || []).length;

  if (!inlineJs.trim()) {
    return { functional: false, signals, inlineScriptCount };
  }

  for (const p of STRONG_PATTERNS) {
    if (p.re.test(inlineJs)) signals.push(p.label);
  }

  const hasContentKw = CONTENT_KEYWORDS.test(inlineJs);
  const hasDomMutation = DOM_MUTATION.test(inlineJs);
  const hasTiming = TIMING.test(inlineJs);

  const comboMatch = hasContentKw && hasDomMutation && hasTiming;
  if (comboMatch) {
    signals.push('inline JS builds content over time (content keyword + DOM mutation + timer)');
  }

  const functional = signals.length > 0;
  // De-dupe signals for a cleaner report.
  return { functional, signals: Array.from(new Set(signals)), inlineScriptCount };
}

module.exports = { detectDynamicScripts, extractInlineScriptText };
