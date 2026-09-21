/**
 * Auto-heal cloned landers after we strip competitor JS (bouncers / pixels).
 *
 * 1. Known messenger quiz (Landerlab-like) → dedicated engine.
 * 2. CTA quiz popup (#ssqOverlay) or inline pitch quiz (.ssq-inline) → freeze
 *    questions into the DOM and replay with injectPopupQuizEngine.
 *    VTurb snippets pasted in <head> are moved into #vsl-anchor.
 * 3. Anything else with hidden steps / data-next* → generic stepper so a
 *    new landing works on the first clone without a human adapter.
 *
 * Keep in sync with worker-lib/lander-heal.js
 */

import { injectChatQuizEngine, isChatQuizHtml } from './chat-quiz-engine';
import { injectPopupQuizEngine, isPopupQuizHtml } from './popup-quiz-engine';

export type LanderIssue = { id: string; label: string };

export type HealResult = {
  html: string;
  applied: string[];
  remaining: LanderIssue[];
};

const HEALED_META = 'wasabi-healed';
const ISSUES_META = 'wasabi-lander-issues';
const GENERIC_STYLE_ID = 'wasabi-generic-step-style';
const GENERIC_SCRIPT_ID = 'wasabi-generic-step-engine';
const OFFLINE_LAYOUT_ID = 'wasabi-offline-layout';

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

export function looksLikeHiddenStepper(html: string): boolean {
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

function markupOnly(html: string): string {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
}

export function diagnoseLander(html: string): LanderIssue[] {
  if (!html) return [];
  const body = markupOnly(html);
  const issues: LanderIssue[] = [];
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

function injectBeforeClose(html: string, style: string, script: string): string {
  let out = html.replace(
    /<(script|style)\b[^>]*\bid=["']wasabi-generic-step[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${style}</head>`);
  else out = `${style}${out}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${script}</body>`);
  return out + script;
}

export function injectGenericStepEngine(html: string): string {
  if (!html || /wasabi-generic-step-engine/.test(html) || /wasabi-chat-quiz-engine/.test(html) || /wasabi-popup-quiz-engine/.test(html)) return html;
  const style = `<style id="${GENERIC_STYLE_ID}">.nodisplay{display:none!important}</style>`;
  const script = `<script id="${GENERIC_SCRIPT_ID}">${GENERIC_STEP_JS}</script>`;
  return injectBeforeClose(html, style, script);
}

/** VTurb snippets are often pasted in <head>; move the player into #vsl-anchor. */
export function placeVturbInAnchor(html: string): string {
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

const SMARTPLAYER_CDN = 'https://scripts.converteai.net/lib/js/smartplayer-wc/v4/smartplayer.js';

/**
 * Offline VSL dumps ship a relative smartplayer.js with id=vturb-smartplayer-js.
 * The official player.js then sees that id and skips injecting the CDN copy,
 * so the custom element never upgrades (black 9:16 box). Also drop the dump's
 * `[class*="loader"]{display:none}` rule that hides VTurb chrome.
 */
export function repairVturbPlayer(html: string): string {
  if (!html || !/vturb-smartplayer|converteai\.net|vturb\.com/i.test(html)) return html;
  let out = html;
  const conv = html.match(/scripts\.converteai\.net\/([0-9a-f-]{36})\/players\/([a-z0-9]+)/i);
  const oid = conv?.[1] || '';
  const pid = conv?.[2] || '';

  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string) => {
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!src) return full;
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (id === 'vturb-smartplayer-js' && !/scripts\.converteai\.net/i.test(src)) {
      return `<script id="vturb-smartplayer-js" src="${SMARTPLAYER_CDN}" fetchpriority="high"><\/script>`;
    }
    if (/\/(?:js\/)?(?:smart)?player\.js(?:\?|$)/i.test(src) && !/converteai\.net|vturb/i.test(src)) {
      return '';
    }
    return full;
  });

  if (/\[class\*=["']loader["']\]/.test(out)) {
    out = out.replace(/,?\s*\[class\*=["']preloader["']\]/gi, '');
    out = out.replace(/,?\s*\[class\*=["']loader["']\]/gi, '');
    out = out.replace(/(\.loading)\s*,\s*\{/gi, '$1{');
  }

  out = placeVturbInAnchor(out);

  if (
    oid &&
    pid &&
    /<vturb-smartplayer\b/i.test(out) &&
    !/images\.converteai\.net\/[^"']+\/(?:thumbnail|cover)\./i.test(out)
  ) {
    const thumb = `https://images.converteai.net/${oid}/players/${pid}/thumbnail.jpg`;
    out = out.replace(
      /(<div\b[^>]*class=["'][^"']*vturb-player-placeholder[^"']*["'][^>]*>)(\s*)(<\/div>)?/i,
      `$1<img class="thumbnail-image" src="${thumb}" alt="" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block">$3`,
    );
  }

  return out;
}

function hasRelativeStylesheet(html: string): boolean {
  const re = /<link\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(attrs)) continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (href && !/^(?:https?:|data:|\/\/)/i.test(href)) return true;
  }
  return false;
}

/** When CSS files were not inlined (HTML-only upload), keep a VSL from collapsing into a wall of text. */
export function injectOfflineLayoutCss(html: string): string {
  if (!html) return html;
  if (html.includes(`id="${OFFLINE_LAYOUT_ID}"`)) return html;
  if (!hasRelativeStylesheet(html) || /data-inlined-from=/.test(html)) return html;
  const css =
    `<style id="${OFFLINE_LAYOUT_ID}">` +
    `*,*::before,*::after{box-sizing:border-box}` +
    `html,body{margin:0;padding:0;background:#fff;color:#1c1f1d;font-family:"Nunito Sans",Poppins,system-ui,sans-serif;line-height:1.45}` +
    `img,video,vturb-smartplayer{max-width:100%;height:auto}` +
    `.container,.principal{width:100%;max-width:900px;margin:0 auto;padding:8px 16px}` +
    `.hero-section h1,.principal h1{font-size:clamp(22px,4vw,34px);line-height:1.2;font-weight:800;text-align:left;margin:12px 0 16px}` +
    `.video-container,#vsl-anchor{max-width:400px;margin:12px auto;width:100%}` +
    `vturb-smartplayer{display:block;margin:0 auto;width:100%;max-width:400px}` +
    `.red-header,header{background:#a70c0c;color:#fff}` +
    `header h1{color:#fff;font-size:1.6rem;text-align:center;margin:0;padding:10px 16px;font-weight:600}` +
    `marquee{display:block;background:#810505;color:#fff;letter-spacing:.12em;text-transform:uppercase;padding:4px 0;font-size:11px}` +
    `.img_adv{max-width:500px;max-height:100px;margin:12px auto;display:block}` +
    `.mt-3{margin-top:1rem}` +
    `#fb-comments,.fb-heading{max-width:900px;margin:24px auto 0;padding:0 16px;text-align:left}` +
    `.comments-container{display:flex;flex-direction:column;gap:16px;border:1px solid #e9ebee;border-radius:16px;padding:16px}` +
    `.comment{display:flex;gap:10px;align-items:flex-start;text-align:left}` +
    `.user-avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#e5e7eb;flex-shrink:0}` +
    `.comment-data .user{font-weight:700}` +
    `.esconder{display:block!important}` +
    `footer{background:#a70c0c;color:#fff;padding:16px;text-align:center}` +
    `</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${css}</head>`);
  return css + html;
}

export function healClonedLander(html: string): HealResult {
  if (!html) return { html, applied: [], remaining: [] };
  let out = repairVturbPlayer(html);
  const applied: string[] = [];
  if (/vturb-smartplayer/i.test(html) && out !== html) applied.push('vturb-anchor');

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
      if (/wasabi-generic-step-engine/.test(out) && !applied.includes('generic-step')) {
        applied.push('generic-step');
      }
    }
    remaining = diagnoseLander(out);
  }

  const laid = injectOfflineLayoutCss(out);
  if (laid !== out) {
    out = laid;
    applied.push('offline-layout');
  }

  out = stamp(out, Array.from(new Set(applied)), remaining);
  return { html: out, applied: Array.from(new Set(applied)), remaining };
}
