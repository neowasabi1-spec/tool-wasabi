/**
 * Port of src/lib/lander-heal.ts for the OpenClaw worker (CJS).
 * Keep in sync with the TypeScript source.
 */

const { injectChatQuizEngine, isChatQuizHtml } = require('./chat-quiz-engine');
const { injectPopupQuizEngine, isPopupQuizHtml } = require('./popup-quiz-engine');

const HEALED_META = 'wasabi-healed';
const ISSUES_META = 'wasabi-lander-issues';
const GENERIC_STYLE_ID = 'wasabi-generic-step-style';
const GENERIC_SCRIPT_ID = 'wasabi-generic-step-engine';

const GENERIC_STEP_JS = `(function(){
if(window.__wasabiChatQuiz||window.__wasabiGenericStep)return;
window.__wasabiGenericStep=1;
function q(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}
function show(el){
  if(!el)return;
  el.classList.remove('nodisplay','hidden','hide','d-none','is-hidden','hide-me');
  el.removeAttribute('hidden');
  el.style.removeProperty('display');
  el.style.removeProperty('visibility');
  el.style.removeProperty('opacity');
}
function hide(el){
  if(!el)return;
  el.classList.add('nodisplay');
}
function stepList(){
  var out=[];
  q('[data-step],.quiz-panel,.chatbox[data-step],[data-step-reply],.quiz-step,.funnel-step,[data-slide]').forEach(function(el){
    if(out.indexOf(el)>=0)return;
    out.push(el);
  });
  if(out.length<2){
    q('.nodisplay,[hidden]').forEach(function(el){
      if(!el.children||!el.children.length)return;
      if(el.parentElement&&el.parentElement.closest&&el.parentElement.closest('script,style'))return;
      if(out.indexOf(el)>=0)return;
      out.push(el);
    });
  }
  return out;
}
function findStep(token){
  if(!token)return null;
  if(token==='loading'||token==='loader'){
    return document.getElementById('quiz-loading')||document.querySelector('.quiz-loading,.loading-panel');
  }
  var escaped=String(token).replace(/"/g,'');
  var hit=document.querySelector('[data-step="'+escaped+'"],[data-step-reply="'+escaped+'"],[data-id="'+escaped+'"]');
  if(hit)return hit;
  if(document.getElementById(escaped))return document.getElementById(escaped);
  return document.querySelector('#step-'+escaped+',#step'+escaped+',.step-'+escaped);
}
function onClick(ev){
  var t=ev.target;
  if(!t||!t.closest)return;
  var realLink=t.closest('a[href]');
  if(realLink){
    var href=realLink.getAttribute('href')||'';
    if(/^https?:\\/\\//i.test(href)||href.slice(0,2)==='//')return;
  }
  if(t.closest('button[type="submit"],input,select,textarea'))return;
  var btn=t.closest('[data-next-chat],[data-next-step],[data-next],[data-goto],[data-show],[data-target],.chat-button,.quiz-button,[data-form-step-reply],button,a,[role="button"]');
  if(!btn)return;
  var next=(btn.getAttribute('data-next-chat')||btn.getAttribute('data-next-step')||btn.getAttribute('data-next')||btn.getAttribute('data-goto')||btn.getAttribute('data-show')||btn.getAttribute('data-target')||'').trim();
  if(next.charAt(0)==='#')next=next.slice(1);
  var all=stepList();
  var current=null;
  for(var i=0;i<all.length;i++){if(all[i].contains(btn)){current=all[i];break;}}
  var target=next?findStep(next):null;
  if(!target&&current){
    var idx=all.indexOf(current);
    target=idx>=0?all[idx+1]:null;
  }
  if(!target)return;
  ev.preventDefault();
  ev.stopPropagation();
  if(current&&current!==target)hide(current);
  show(target);
  var inner=q('.nodisplay,[hidden]',target);
  if(inner.length&&inner.length<=12)inner.forEach(show);
  try{target.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}
}
document.addEventListener('click',onClick,true);
})();`;

function countClass(html, name) {
  const re = new RegExp(`\\b${name}\\b`, 'gi');
  return (html.match(re) || []).length;
}

function looksLikeAccordion(html) {
  if (/<details\b/i.test(html) && /<summary\b/i.test(html)) return true;
  if (/\b(faq-item|faq-question|accordion-item|accordion-header)\b/i.test(html)) return true;
  if (/\bfk-collapsible-list-item\b/i.test(html)) return true;
  return false;
}

function looksLikeCarousel(html) {
  return /\b(swiper-wrapper|slider-for|slick-track|splide__track)\b/i.test(html);
}

function looksLikeHiddenStepper(html) {
  if (!html) return false;
  if (isPopupQuizHtml(html)) return false;
  if (isChatQuizHtml(html)) return true;
  const hidden = countClass(html, 'nodisplay') + (html.match(/\shidden(?:\s|>|=)/gi) || []).length;
  const nextAttr = /data-next(?:-chat|-step)?\s*=/i.test(html) || /data-goto\s*=/i.test(html) || /data-show\s*=/i.test(html);
  const steps = /data-step\s*=/i.test(html) || /\bquiz-panel\b/i.test(html) || /\bquiz-step\b/i.test(html);
  if (nextAttr && (steps || hidden >= 2)) return true;
  if (hidden >= 5 && /\b(button|chat-button|quiz-button)\b/i.test(html)) return true;
  return false;
}

function markupOnly(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
}

function diagnoseLander(html) {
  if (!html) return [];
  const body = markupOnly(html);
  const issues = [];
  const hasChatEngine = /wasabi-chat-quiz-engine/.test(html);
  const hasGeneric = /wasabi-generic-step-engine/.test(html);
  const hasPopupQuiz = /wasabi-popup-quiz-engine/.test(html);
  if (isPopupQuizHtml(html) && !hasPopupQuiz) {
    issues.push({ id: 'frozen-popup-quiz', label: 'CTA quiz popup without engine' });
  }
  if (isChatQuizHtml(body) && !hasChatEngine) {
    issues.push({ id: 'frozen-chat-quiz', label: 'Messenger quiz without engine' });
  }
  if (looksLikeAccordion(body) && !/wasabi-accordion-rescue/.test(html) && !isChatQuizHtml(body)) {
    issues.push({ id: 'frozen-accordion', label: 'FAQ/accordion without click rescue' });
  }
  if (looksLikeCarousel(body) && !/wasabi-accordion-rescue/.test(html) && !/__wbCar/.test(html)) {
    issues.push({ id: 'frozen-carousel', label: 'Carousel without fallback' });
  }
  if (looksLikeHiddenStepper(body) && !hasChatEngine && !hasGeneric && !hasPopupQuiz) {
    issues.push({ id: 'hidden-steps', label: 'Hidden steps with no stepper' });
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

function injectBeforeClose(html, style, script) {
  let out = html.replace(
    /<(script|style)\b[^>]*\bid=["']wasabi-generic-step[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${style}</head>`);
  else out = `${style}${out}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${script}</body>`);
  return out + script;
}

function injectGenericStepEngine(html) {
  if (!html || /wasabi-generic-step-engine/.test(html) || /wasabi-chat-quiz-engine/.test(html) || /wasabi-popup-quiz-engine/.test(html)) return html;
  const style = `<style id="${GENERIC_STYLE_ID}">.nodisplay{display:none!important}</style>`;
  const script = `<script id="${GENERIC_SCRIPT_ID}">${GENERIC_STEP_JS}</script>`;
  return injectBeforeClose(html, style, script);
}

function placeVturbInAnchor(html) {
  if (!html) return html;
  const m = html.match(/<vturb-smartplayer\b[\s\S]*?<\/vturb-smartplayer>/i);
  if (!m) return html;
  const player = m[0];
  if (!/id=["']vsl-anchor["']/i.test(html)) return html;
  const anchorIdx = html.search(/id=["']vsl-anchor["']/i);
  const playerIdx = html.indexOf(player);
  if (anchorIdx >= 0 && playerIdx > anchorIdx && playerIdx - anchorIdx < 2500) return html;
  const stripped = html.replace(player, '');
  if (!/id=["']vsl-anchor["']/i.test(stripped)) return html;
  return stripped.replace(
    /(<div\b[^>]*id=["']vsl-anchor["'][^>]*>)/i,
    `$1${player}`,
  );
}

function healClonedLander(html) {
  if (!html) return { html, applied: [], remaining: [] };
  let out = placeVturbInAnchor(html);
  const applied = [];
  if (out !== html) applied.push('vturb-anchor');

  if (isPopupQuizHtml(out)) {
    out = injectPopupQuizEngine(out);
    if (/wasabi-popup-quiz-engine/.test(out)) applied.push('popup-quiz');
  } else if (isChatQuizHtml(out)) {
    out = injectChatQuizEngine(out);
    if (/wasabi-chat-quiz-engine/.test(out)) applied.push('chat-quiz');
  } else if (looksLikeHiddenStepper(out)) {
    out = injectGenericStepEngine(out);
    if (/wasabi-generic-step-engine/.test(out)) applied.push('generic-step');
  }

  if (/wasabi-accordion-rescue/.test(out)) applied.push('accordion');

  let remaining = diagnoseLander(out);
  if (remaining.some((i) => i.id === 'hidden-steps' || i.id === 'frozen-chat-quiz')) {
    if (!/wasabi-chat-quiz-engine/.test(out) && !/wasabi-popup-quiz-engine/.test(out)) {
      out = injectGenericStepEngine(out);
      if (/wasabi-generic-step-engine/.test(out) && applied.indexOf('generic-step') < 0) {
        applied.push('generic-step');
      }
    }
    remaining = diagnoseLander(out);
  }

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

module.exports = {
  diagnoseLander,
  healClonedLander,
  readHealStamp,
  looksLikeHiddenStepper,
  injectGenericStepEngine,
};
