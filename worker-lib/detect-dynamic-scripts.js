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

// Inline scripts that are ONLY tracking/analytics — not worth re-attaching
// after an editor round-trip. If the block also mutates the DOM we keep it.
const TRACKING_ONLY =
  /googletagmanager|gtag\s*\(|fbq\s*\(|fbevents|connect\.facebook|hotjar|clarity\.ms|mixpanel|segment\.(io|com)|google-analytics|_gaq|snaptr|ttq\.|pintrk|dataLayer\.push/i;

const REINJECT_OPEN = '<!--cloned-dynamic-scripts-->';
const REINJECT_CLOSE = '<!--/cloned-dynamic-scripts-->';

/**
 * Extract the full <script>…</script> blocks safe to re-inject after the
 * visual editor stripped them (inline page logic, not analytics/pixels).
 */
function extractReinjectableScripts(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const body = m[2] || '';
    if (!body.trim()) continue;
    if (/data-fallback|data-swipe-replacer|data-editor/i.test(attrs)) continue;
    if (TRACKING_ONLY.test(body) && !DOM_MUTATION.test(body)) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * Re-attach functional inline scripts from a pristine clone into an edited
 * copy that had its scripts stripped. Idempotent; no-op when the pristine
 * page has no content-generating scripts.
 */
function reattachDynamicScripts(pristine, edited) {
  if (!edited) return edited;
  if (!detectDynamicScripts(pristine).functional) return edited;
  const blocks = extractReinjectableScripts(pristine);
  if (blocks.length === 0) return edited;
  let out = edited.replace(
    new RegExp(`${REINJECT_OPEN}[\\s\\S]*?${REINJECT_CLOSE}`, 'g'),
    '',
  );
  const payload = `${REINJECT_OPEN}\n${blocks.join('\n')}\n${REINJECT_CLOSE}`;
  out = out.includes('</body>')
    ? out.replace('</body>', `${payload}</body>`)
    : out + payload;
  return out;
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

  // NOTE (regression fix 2026-07-08): a loose combo — content keyword + DOM
  // mutation + timer — used to ALSO flag a page as functional. But
  // innerHTML/appendChild/createElement + setTimeout + a generic word like
  // "reviews"/"feed"/"notification"/"sold" appears in almost EVERY SPA/JS
  // page. That false-positive made the swipe pipeline stop freezing SPAs
  // (previewMode &&!hasFunctionalScripts), so the framework re-hydrated and
  // OVERWROTE the rewritten copy — the page came back looking like the
  // original. We now require a SPECIFIC engine signature (STRONG_PATTERNS:
  // comment engine, content-container selectors, viewer counter, offer
  // reveal). The combo is reported for diagnostics only and never flips the
  // decision on its own.
  const combo = CONTENT_KEYWORDS.test(inlineJs) && DOM_MUTATION.test(inlineJs) && TIMING.test(inlineJs);
  const functional = signals.length > 0;
  const reported = functional && combo
    ? signals.concat('inline JS builds content over time (content keyword + DOM mutation + timer)')
    : signals;
  // De-dupe signals for a cleaner report.
  return { functional, signals: Array.from(new Set(reported)), inlineScriptCount };
}

module.exports = {
  detectDynamicScripts,
  extractInlineScriptText,
  extractReinjectableScripts,
  reattachDynamicScripts,
};
