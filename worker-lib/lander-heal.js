/**
 * Port of src/lib/lander-heal.ts for the OpenClaw worker (CJS).
 * Keep in sync with the TypeScript source.
 */

const { injectChatQuizEngine, isChatQuizHtml } = require('./chat-quiz-engine');

const HEALED_META = 'wasabi-healed';
const ISSUES_META = 'wasabi-lander-issues';

function looksLikeAccordion(html) {
  if (/<details\b/i.test(html) && /<summary\b/i.test(html)) return true;
  if (/\b(faq-item|faq-question|accordion-item|accordion-header)\b/i.test(html)) return true;
  if (/\bfk-collapsible-list-item\b/i.test(html)) return true;
  return false;
}

function looksLikeCarousel(html) {
  return /\b(swiper-wrapper|slider-for|slick-track|splide__track)\b/i.test(html);
}

function diagnoseLander(html) {
  if (!html) return [];
  const issues = [];
  if (isChatQuizHtml(html) && !/wasabi-chat-quiz-engine/.test(html)) {
    issues.push({ id: 'frozen-chat-quiz', label: 'Messenger quiz is hidden and has no replay engine' });
  }
  if (looksLikeAccordion(html) && !/wasabi-accordion-rescue/.test(html) && !isChatQuizHtml(html)) {
    issues.push({ id: 'frozen-accordion', label: 'FAQ/accordion markup without click rescue' });
  }
  if (looksLikeCarousel(html) && !/wasabi-accordion-rescue/.test(html) && !/__wbCar/.test(html)) {
    issues.push({ id: 'frozen-carousel', label: 'Carousel markup without a fallback binder' });
  }
  const hidden = (html.match(/\bnodisplay\b/gi) || []).length;
  if (hidden >= 8 && !isChatQuizHtml(html) && !/wasabi-chat-quiz-engine/.test(html)) {
    issues.push({ id: 'hidden-steps', label: 'Many .nodisplay sections — JS stepper without an adapter' });
  }
  return issues;
}

function stamp(html, applied, remaining) {
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

function healClonedLander(html) {
  if (!html) return { html, applied: [], remaining: [] };
  let out = html;
  const applied = [];
  if (isChatQuizHtml(out)) {
    out = injectChatQuizEngine(out);
    if (/wasabi-chat-quiz-engine/.test(out)) applied.push('chat-quiz');
  }
  if (/wasabi-accordion-rescue/.test(out)) applied.push('accordion');
  const remaining = diagnoseLander(out);
  out = stamp(out, Array.from(new Set(applied)), remaining);
  return { html: out, applied: Array.from(new Set(applied)), remaining };
}

function readHealStamp(html) {
  const appliedRaw = String(html || '').match(
    new RegExp(`<meta\\s+name=["']${HEALED_META}["'][^>]*content=["']([^"']*)["']`, 'i'),
  );
  const issuesRaw = String(html || '').match(
    new RegExp(`<meta\\s+name=["']${ISSUES_META}["'][^>]*content=["']([^"']*)["']`, 'i'),
  );
  const applied = appliedRaw && appliedRaw[1]
    ? appliedRaw[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const remaining = (issuesRaw && issuesRaw[1] ? issuesRaw[1] : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
  return { html, applied, remaining };
}

module.exports = { diagnoseLander, healClonedLander, readHealStamp };
