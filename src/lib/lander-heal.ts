/**
 * Auto-heal for cloned landers whose original JS we strip (bouncers, pixels).
 *
 * Clone/Swipe cannot keep competitor runtime. Each "weird" landing family
 * (Landerlab messenger, Funnelish FAQ, …) gets one adapter: detect + fix.
 * `healClonedLander` runs on every clone/stabilize. New families belong HERE
 * once — after that, clones of that family heal without a chat report.
 *
 * Keep in sync with worker-lib/lander-heal.js
 */

import { injectChatQuizEngine, isChatQuizHtml } from './chat-quiz-engine';

export type LanderIssue = { id: string; label: string };

export type HealResult = {
  html: string;
  applied: string[];
  remaining: LanderIssue[];
};

const HEALED_META = 'wasabi-healed';
const ISSUES_META = 'wasabi-lander-issues';

function countClass(html: string, name: string): number {
  const re = new RegExp(`\\b${name}\\b`, 'gi');
  return (html.match(re) || []).length;
}

function looksLikeAccordion(html: string): boolean {
  if (/<details\b/i.test(html) && /<summary\b/i.test(html)) return true;
  if (/\b(faq-item|faq-question|accordion-item|accordion-header)\b/i.test(html)) return true;
  if (/\bfk-collapsible-list-item\b/i.test(html)) return true;
  return false;
}

function looksLikeCarousel(html: string): boolean {
  return /\b(swiper-wrapper|slider-for|slick-track|splide__track)\b/i.test(html);
}

export function diagnoseLander(html: string): LanderIssue[] {
  if (!html) return [];
  const issues: LanderIssue[] = [];
  if (isChatQuizHtml(html) && !/wasabi-chat-quiz-engine/.test(html)) {
    issues.push({
      id: 'frozen-chat-quiz',
      label: 'Messenger quiz is hidden (nodisplay / data-next) and has no replay engine',
    });
  }
  if (looksLikeAccordion(html) && !/wasabi-accordion-rescue/.test(html) && !isChatQuizHtml(html)) {
    issues.push({
      id: 'frozen-accordion',
      label: 'FAQ/accordion markup without click rescue',
    });
  }
  if (looksLikeCarousel(html) && !/wasabi-accordion-rescue/.test(html) && !/__wbCar/.test(html)) {
    issues.push({
      id: 'frozen-carousel',
      label: 'Carousel markup without a fallback binder',
    });
  }
  if (countClass(html, 'nodisplay') >= 8 && !isChatQuizHtml(html) && !/wasabi-chat-quiz-engine/.test(html)) {
    issues.push({
      id: 'hidden-steps',
      label: 'Many .nodisplay sections — likely a JS stepper we do not replay yet',
    });
  }
  return issues;
}

function stamp(html: string, applied: string[], remaining: LanderIssue[]): string {
  let out = html.replace(new RegExp(`<meta\\s+name=["']${HEALED_META}["'][^>]*>`, 'gi'), '');
  out = out.replace(new RegExp(`<meta\\s+name=["']${ISSUES_META}["'][^>]*>`, 'gi'), '');
  const tags =
    (applied.length ? `<meta name="${HEALED_META}" content="${applied.join(',')}">` : '') +
    (remaining.length
      ? `<meta name="${ISSUES_META}" content="${remaining.map((i) => i.id).join(',')}">`
      : '');
  if (!tags) return out;
  if (/<\/head>/i.test(out)) return out.replace(/<\/head>/i, `${tags}</head>`);
  if (/<head\b[^>]*>/i.test(out)) return out.replace(/(<head\b[^>]*>)/i, `$1${tags}`);
  return tags + out;
}

export function readHealStamp(html: string): HealResult {
  const appliedRaw = html.match(new RegExp(`<meta\\s+name=["']${HEALED_META}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const issuesRaw = html.match(new RegExp(`<meta\\s+name=["']${ISSUES_META}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const applied = appliedRaw?.[1] ? appliedRaw[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const remaining = (issuesRaw?.[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
  return { html, applied, remaining };
}

/**
 * Apply every matching adapter, then re-diagnose. Idempotent.
 * Accordion/carousel rescue is injected by `injectInteractivityRescue`
 * before this runs; we still force the chat-quiz engine if detection
 * says the page is a messenger stepper.
 */
export function healClonedLander(html: string): HealResult {
  if (!html) return { html, applied: [], remaining: [] };
  let out = html;
  const applied: string[] = [];

  if (isChatQuizHtml(out)) {
    out = injectChatQuizEngine(out);
    if (/wasabi-chat-quiz-engine/.test(out)) applied.push('chat-quiz');
  }

  if (/wasabi-accordion-rescue/.test(out)) applied.push('accordion');

  const remaining = diagnoseLander(out);
  out = stamp(out, Array.from(new Set(applied)), remaining);
  return { html: out, applied: Array.from(new Set(applied)), remaining };
}
