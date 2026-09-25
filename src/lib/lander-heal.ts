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

const ROUTE_SHIM = `<script id="wasabi-cc-route">(function(){
if(window.__wasabiCcRoute)return;
window.__wasabiCcRoute=1;
document.addEventListener('click',function(ev){
  var t=ev.target;
  if(!t||!t.closest)return;
  var b=t.closest('button[action="route"],[onclick*="route("]');
  if(!b)return;
  ev.preventDefault();
  var dest=document.querySelector('.fk-payment-option,form,[id*="order" i],[class*="checkout"],[class*="offer-box"]');
  if(dest&&dest.scrollIntoView){
    try{dest.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){dest.scrollIntoView();}
  }
},true);
})();</script>`;

/**
 * Checkout Champ / FunnelKonnekt snapshots break once their runtime is gone:
 * stylesheets stay media="print" because onload never flips them, lazy imgs
 * keep src="", body stays .dom-pending, and index.js is loaded from
 * window.location (about:srcdoc) so it throws. Bake the visible page instead.
 */
export function bakeCheckoutChampSnapshot(html: string): string {
  if (!html || !/checkoutchamp|funnelkonnekt|fk-lazy|dom-pending|action=["']route["']/i.test(html)) {
    return html;
  }
  let out = html;

  out = out.replace(/<link\b([^>]*?)\/?>/gi, (full, attrs: string) => {
    const onload = attrs.match(/\bonload\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const onloadVal = onload ? (onload[1] || onload[2] || '') : '';
    if (!onloadVal) return full;
    const isSheet = /\brel\s*=\s*["']?stylesheet["']?/i.test(attrs);
    const isPreload = /\brel\s*=\s*["']?preload["']?/i.test(attrs) && /\bas\s*=\s*["']style["']/i.test(attrs);
    if (isSheet && /this\.media\s*=/i.test(onloadVal)) {
      let a = attrs
        .replace(/\smedia\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
        .replace(/\sonload\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
      if (!/\bmedia\s*=/i.test(a)) a += ' media="all"';
      return `<link${a}>`;
    }
    if (isPreload && /this\.rel\s*=/i.test(onloadVal)) {
      let a = attrs
        .replace(/\srel\s*=\s*(?:"[^"]*"|'[^']*')/i, ' rel="stylesheet"')
        .replace(/\sas\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
        .replace(/\sonload\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
      return `<link${a}>`;
    }
    return full;
  });

  out = out.replace(/<(img|source|iframe|video)\b([^>]*)>/gi, (full, tag: string, attrs: string) => {
    const src = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const existing = src ? (src[1] ?? src[2] ?? '') : null;
    const placeholder = existing == null || existing === '' || existing === '#' || /^data:image/i.test(existing);
    if (!placeholder) return full;
    const lazy = attrs.match(/\sdata-(?:src|lazy-src|original|image|lazy)\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const val = lazy ? (lazy[1] || lazy[2] || '') : '';
    if (!val || val.startsWith('data:')) return full;
    if (src) {
      const next = attrs.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*')/i, ` src="${val.replace(/"/g, '&quot;')}"`);
      return `<${tag}${next}>`;
    }
    return `<${tag}${attrs} src="${val.replace(/"/g, '&quot;')}">`;
  });

  out = out.replace(/<body\b([^>]*)>/i, (_full, attrs: string) => {
    const next = attrs
      .replace(/\bdom-pending\b/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\sclass=(["'])\s*\1/g, '');
    return `<body${next}>`;
  });

  out = out.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*fkDynamicScript(?:(?!<\/script>)[\s\S])*<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*button\[action=route\](?:(?!<\/script>)[\s\S])*<\/script>/gi, '');

  if (/action=["']route["']|onclick=["']route\(event\)["']/i.test(out) && !/id=["']wasabi-cc-route["']/.test(out)) {
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${ROUTE_SHIM}</body>`) : out + ROUTE_SHIM;
  }

  return out;
}

function escMq(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** First `[...]` after `from`, respecting strings. A lazy `]` stops inside "options". */
function balancedArray(source: string, from: number): string | null {
  const start = source.indexOf('[', from);
  if (start < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export type MessengerFlow = {
  containerId: string;
  intros?: string[];
  startLabel?: string;
  questions: Array<{ label?: string; question?: string; options?: string[] }>;
  resultTitle?: string;
  resultCta?: string;
  resultHref?: string;
  avatarSrc?: string;
};

/** Turn a script-built chat into real steps. Later questions stay hidden until the click before them. */
export function applyMessengerFlow(html: string, flow: MessengerFlow): string {
  if (!html || /id=["']wasabi-mq-css["']/.test(html)) return html;
  const id = String(flow.containerId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const questions = (flow.questions || []).filter((q) => q && (q.question || q.label)).slice(0, 12);
  if (!id || !questions.length) return html;
  const avatar = flow.avatarSrc || html.match(/<img\b[^>]*class=["'][^"']*(?:avatar|kate-avatar)[^"']*["'][^>]*src=["']([^"']+)/i)?.[1] || '';
  const bot = (inner: string, extra = '') =>
    `<div class="msg-row bot${extra}">${avatar ? `<img class="msg-mini-avatar" src="${escMq(avatar)}" alt="">` : ''}<div class="bubble">${inner}</div></div>`;
  let steps = (flow.intros || []).slice(0, 8).map((t) => bot(escMq(String(t)))).join('');
  const start = flow.startLabel || 'Continue';
  steps += `<input type="checkbox" id="mq-go" class="mq-ctl"><label for="mq-go" class="yes-btn">${escMq(start)}</label>`;
  const rules = [
    `#${id} .mq-ctl{position:absolute;opacity:0;pointer-events:none;width:0;height:0}`,
    `#${id} .mq-q{display:none!important}`,
    `#mq-go:checked~label.yes-btn{display:none!important}`,
    `#mq-go:checked~.mq-show-0{display:flex!important}`,
  ];
  questions.forEach((q, i) => {
    const opts = q.options?.length ? q.options.slice(0, 6) : ['Yes', 'No'];
    steps += bot(
      `${q.label ? `<div>${escMq(String(q.label))}</div>` : ''}<strong>${escMq(String(q.question || q.label || ''))}</strong>`,
      ` mq-q mq-show-${i}`,
    );
    opts.forEach((label, oi) => {
      const cid = `mq-a${i}-${oi}`;
      const tone = String(label).toLowerCase() === 'yes' ? ' answer-yes' : String(label).toLowerCase() === 'no' ? ' answer-no' : '';
      steps += `<input type="radio" class="mq-ctl" name="mq-a${i}" id="${cid}">`;
      steps += `<label for="${cid}" class="option-btn mq-q mq-show-${i}${tone}">${escMq(String(label))}</label>`;
      rules.push(`#${cid}:checked~.mq-show-${i + 1}{display:flex!important}`);
    });
  });
  steps += `<div id="mq-results" class="quiz-panel quiz-results mq-q mq-show-${questions.length}"><h2>${escMq(flow.resultTitle || 'You qualify')}</h2><a class="quiz-results-cta" href="${escMq(flow.resultHref || '#')}">${escMq(flow.resultCta || 'Continue')}</a></div>`;
  const slot = new RegExp(`<div\\s+id=["']${id}["'][^>]*>\\s*<\\/div>`, 'i');
  if (!slot.test(html)) return html;
  let out = html.replace(slot, `<div id="${id}">${steps}</div>`);
  const style = `<style id="wasabi-mq-css">${rules.join('')}</style>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${style}</head>`) : style + out;
  return paceMessengerIntros(out);
}

const MQ_PACE_CSS = '#chatbox-content>.msg-row.bot:not(.mq-q){display:none!important}#chatbox-content>.msg-row.bot.mq-on{display:flex!important}#chatbox-content>label.yes-btn{display:none!important}#chatbox-content>label.yes-btn.mq-on{display:inline-block!important}#chatbox-content .mq-q.mq-on:not(.quiz-panel){display:flex!important}#chatbox-content label.option-btn.mq-on{display:block!important}#chatbox-content #quiz-loading.mq-on,#chatbox-content #quiz-results.mq-on{display:block!important;width:auto!important}#chatbox-content .mq-q:not(.mq-on),#chatbox-content label.option-btn:not(.mq-on){display:none!important}';
const MQ_LOADING = `<section id="quiz-loading" class="quiz-panel mq-q"><div class="quiz-loading-icon" aria-hidden="true">&#10003;</div><h2>Checking Your Eligibility...</h2><p>Confirming that you can continue to the online application</p><div class="quiz-loading-stats"><div class="quiz-loading-stat">Reviewing basic requirements <span class="check">&#10003;</span></div><div class="quiz-loading-stat">Checking online application access <span class="check">&#10003;</span></div><div class="quiz-loading-stat">Confirming permit pathway <span class="check">&#10003;</span></div><div class="quiz-loading-stat">Qualification status: <strong>Eligible</strong><span class="check">&#10003;</span></div></div><div class="quiz-progress"><div class="quiz-progress-fill" id="quiz-loading-bar" style="width:0%"></div></div><div class="quiz-loading-pct"><span id="quiz-loading-pct">0</span>%</div></section>`;
const MQ_RESULTS = `<section id="quiz-results" class="quiz-panel quiz-results mq-q"><div class="quiz-results-center"><span class="quiz-results-badge">&#10003; YOU QUALIFY!</span></div><h2>Your Online Concealed Carry Permit Is Ready!</h2><p>Based on your answers, you qualify for a concealed carry permit.</p><div class="quiz-next-step-card"><div class="quiz-next-step-label">Next steps:</div><div class="quiz-next-step-title">Complete Your Online Application</div><ol><li>Click through to the next page.</li><li>Submit your information through the official online portal.</li><li>Receive your permit and start carrying legally in all 50 states.</li></ol></div><a class="quiz-results-cta" href="https://apply.securemyconcealedpermit.com/click">Continue to Claim Your Permit »</a></section>`;
const MQ_PACE_SCRIPT = `<script id="wasabi-mq-pace">(function(){var box=document.getElementById('chatbox-content');if(!box||box.getAttribute('data-mq-pace'))return;box.setAttribute('data-mq-pace','1');var intros=[],kids=box.children,i;for(i=0;i<kids.length;i++){var el=kids[i];if(el.classList&&el.classList.contains('msg-row')&&el.classList.contains('bot')&&!el.classList.contains('mq-q'))intros.push(el);}var btn=box.querySelector('label.yes-btn');var n=0;function greet(){if(n<intros.length){intros[n].classList.add('mq-on');n++;setTimeout(greet,900);return;}if(btn)btn.classList.add('mq-on');}setTimeout(greet,500);var total=box.querySelectorAll('.msg-row.mq-q').length||1;function showStep(idx){var nodes=box.querySelectorAll('.mq-show-'+idx);for(var k=0;k<nodes.length;k++)nodes[k].classList.add('mq-on');var area=document.getElementById('progress-area');if(area)area.style.display='block';var pct=Math.round((idx/total)*100);var fill=document.getElementById('progress-fill');var pctEl=document.getElementById('progress-pct');var label=document.getElementById('progress-label');if(fill)fill.style.width=pct+'%';if(pctEl)pctEl.textContent=pct+'%';if(label)label.textContent='Question '+(idx+1)+' of '+total;}function runCheck(){var fill=document.getElementById('progress-fill');var pctEl=document.getElementById('progress-pct');var label=document.getElementById('progress-label');if(fill)fill.style.width='100%';if(pctEl)pctEl.textContent='100%';if(label)label.textContent='Questions Complete!';var loading=document.getElementById('quiz-loading');var results=document.getElementById('quiz-results');if(loading)loading.classList.add('mq-on');var stats=loading?loading.querySelectorAll('.quiz-loading-stat'):[];var times=[600,1300,2000,2800];for(var s=0;s<stats.length;s++){(function(el,t){setTimeout(function(){el.classList.add('visible');},t);})(stats[s],times[s]||600);}var bar=document.getElementById('quiz-loading-bar');var lp=document.getElementById('quiz-loading-pct');var start=Date.now();var tick=setInterval(function(){var p=Math.min(100,Math.round(((Date.now()-start)/3600)*100));if(bar)bar.style.width=p+'%';if(lp)lp.textContent=String(p);if(p>=100){clearInterval(tick);setTimeout(function(){if(loading)loading.classList.remove('mq-on');if(results)results.classList.add('mq-on');},250);}},60);}box.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;if(t.closest('label.yes-btn')){e.preventDefault();showStep(0);return;}var opt=t.closest('label.option-btn');if(!opt)return;e.preventDefault();var m=String(opt.className).match(/mq-show-(\\d+)/);var idx=m?parseInt(m[1],10):0;if(box.querySelector('.msg-row.mq-show-'+(idx+1)))showStep(idx+1);else runCheck();});})();</script>`;

/**
 * Saved/exported HTML has no editor script. CheckoutChamp also drops inline JS.
 * CSS reveals each greeting, then each answer, then the eligibility card.
 */
export function exportMessengerHtml(html: string): string {
  if (!html || !/id=["']wasabi-mq-css["']/.test(html)) return html;
  let out = html.replace(/<style\b[^>]*\bid=["']wasabi-mq-export["'][^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<input\b[^>]*\bid=["']mq-go["'][^>]*>/i, (tag) => {
    const bare = tag.replace(/\schecked(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi, '');
    return bare.replace(/>$/, ' checked>');
  });
  out = out.replace(/<input\b[^>]*\bclass=["'][^"']*\bmq-ctl\b[^"']*["'][^>]*>/gi, (tag) => {
    if (/\bid=["']mq-go["']/i.test(tag)) return tag;
    return tag.replace(/\schecked(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi, '');
  });
  const intros = out.match(/class="msg-row bot"/g)?.length || 3;
  const questions = out.match(/class="msg-row bot mq-q/g)?.length || 3;
  const btnDelay = (0.45 + intros * 0.9).toFixed(2);
  const steps: string[] = [];
  for (let i = 0; i < 12; i++) {
    const prev = [`#chatbox-content #mq-a${i}-0:checked~.mq-show-${i + 1}`, `#chatbox-content #mq-a${i}-1:checked~.mq-show-${i + 1}`];
    steps.push(`${prev.join(',')}{display:flex!important;opacity:1!important}`);
    steps.push(`#chatbox-content #mq-a${i}-0:checked~label.option-btn.mq-show-${i + 1},#chatbox-content #mq-a${i}-1:checked~label.option-btn.mq-show-${i + 1}{display:block!important}`);
    if (i === questions - 1) {
      const load = [`#chatbox-content #mq-a${i}-0:checked~#quiz-loading`, `#chatbox-content #mq-a${i}-1:checked~#quiz-loading`];
      const both = (tail: string) => load.map((s) => `${s}${tail}`).join(',');
      steps.push(`${load.join(',')}{display:block!important;width:auto!important;animation:mqHide .4s 4s forwards}`);
      steps.push(`#chatbox-content #mq-a${i}-0:checked~#quiz-results,#chatbox-content #mq-a${i}-1:checked~#quiz-results{display:block!important;width:auto!important;opacity:0;max-height:0;overflow:hidden;margin:0;padding:0;animation:mqReveal .45s 4.15s forwards}`);
      steps.push(`${both(' .quiz-loading-stat')}{opacity:0;animation:mqStat .35s forwards}`);
      steps.push(`${both(' .quiz-loading-stat:nth-child(1)')}{animation-delay:.6s}`);
      steps.push(`${both(' .quiz-loading-stat:nth-child(2)')}{animation-delay:1.3s}`);
      steps.push(`${both(' .quiz-loading-stat:nth-child(3)')}{animation-delay:2s}`);
      steps.push(`${both(' .quiz-loading-stat:nth-child(4)')}{animation-delay:2.8s}`);
      steps.push(`${both(' #quiz-loading-bar')}{animation:mqBar 3.6s linear forwards}`);
      steps.push(`${both(' #quiz-loading-pct')}{font-size:0;animation:mqCount 3.6s linear forwards;counter-reset:pct var(--pct)}`);
      steps.push(`${both(' #quiz-loading-pct::after')}{content:counter(pct);font-size:2rem}`);
    }
  }
  const css =
    `@keyframes mqFade{from{opacity:0}to{opacity:1}}` +
    `#chatbox-content>.msg-row.bot:not(.mq-q){display:flex!important;opacity:0;animation:mqFade .35s forwards}` +
    `#chatbox-content>.msg-row.bot:not(.mq-q):nth-child(1){animation-delay:.4s}` +
    `#chatbox-content>.msg-row.bot:not(.mq-q):nth-child(2){animation-delay:1.3s}` +
    `#chatbox-content>.msg-row.bot:not(.mq-q):nth-child(3){animation-delay:2.2s}` +
    `#chatbox-content>.msg-row.bot:not(.mq-q):nth-child(4){animation-delay:3.1s}` +
    `#chatbox-content>label.yes-btn{display:inline-block!important;opacity:0;animation:mqFade .35s ${btnDelay}s forwards}` +
    `#chatbox-content .mq-q{display:none!important}` +
    `#chatbox-content #mq-go:checked~label.yes-btn{display:inline-block!important}` +
    `#chatbox-content #mq-go:checked~.mq-show-0,#chatbox-content #mq-go:checked~label.option-btn.mq-show-0{display:none!important}` +
    `#chatbox-content #mq-go:not(:checked)~label.yes-btn{display:none!important;animation:none}` +
    `#chatbox-content #mq-go:not(:checked)~.mq-show-0{display:flex!important;opacity:1!important}` +
    `#chatbox-content #mq-go:not(:checked)~label.option-btn.mq-show-0{display:block!important}` +
    `body:has(#mq-go:not(:checked)) #progress-area{display:block!important}` +
    `@property --pct{syntax:"<integer>";inherits:false;initial-value:0}` +
    `@keyframes mqBar{to{width:100%}}` +
    `@keyframes mqCount{to{--pct:100}}` +
    `@keyframes mqStat{to{opacity:1;transform:none}}` +
    `@keyframes mqHide{to{opacity:0;visibility:hidden;max-height:0;overflow:hidden;margin:0;padding:0}}` +
    `@keyframes mqReveal{to{opacity:1;max-height:900px;overflow:visible;margin:10px 18px 24px 57px;padding:24px 18px}}` +
    steps.join('');
  const tag = `<style id="wasabi-mq-export">${css}</style>`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${tag}</body>`);
  else out += tag;
  return out;
}

/** Intros one at a time, then the permit bar and the eligibility check after the answers. */
export function paceMessengerIntros(html: string): string {
  if (!html || !/id=["']wasabi-mq-css["']/.test(html)) return html;
  let out = html;
  if (!/id=["']quiz-loading["']/.test(out) && /id=["']mq-results["']/.test(out)) {
    out = out.replace(/<div id="mq-results"[\s\S]*?<\/div>/, MQ_LOADING + MQ_RESULTS);
  }
  out = out.replace(/<style\b[^>]*\bid=["']wasabi-mq-editor["'][^>]*>[\s\S]*?<\/style>/gi, '');
  if (/id=["']wasabi-mq-pace["']/.test(out)) return out;
  out = out.replace(/<style id="wasabi-mq-css">/, `<style id="wasabi-mq-css">${MQ_PACE_CSS}`);
  const play = `<style id="wasabi-mq-play">${MQ_PACE_CSS}</style>${MQ_PACE_SCRIPT}`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${play}</body>`);
  else out += play;
  return out;
}

/**
 * Known shape (questions array + addBotMessage). Anything else is left for
 * the clone agent, which reads the script and calls applyMessengerFlow.
 */
function bakeMessengerSteps(html: string): string {
  if (!html || /id=["']wasabi-mq-css["']/.test(html)) return html;
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  const block = scripts.find((s) => /\bvar\s+questions\s*=/.test(s));
  if (!block) return html;
  const at = block.search(/\bvar\s+questions\s*=\s*/);
  const json = balancedArray(block, at);
  let questions: MessengerFlow['questions'] = [];
  try { questions = JSON.parse(json); } catch { return html; }
  const initBody = block.match(/function\s+init\s*\(\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || block;
  const intros: string[] = [];
  const introRe = /addBotMessage\(\s*(['"])([\s\S]*?)\1\s*\)/g;
  let im: RegExpExecArray | null;
  while ((im = introRe.exec(initBody))) intros.push(im[2]);
  const containerId = /chatbox-content/.test(html) ? 'chatbox-content' : (html.match(/id=["']([^"']+)["'][^>]*>\s*<\/div>/i)?.[1] || 'chatbox-content');
  const out = applyMessengerFlow(html, {
    containerId,
    intros,
    startLabel: block.match(/addYesButton\(\s*(['"])([\s\S]*?)\1/)?.[2] || 'Continue',
    questions,
    avatarSrc: block.match(/src=["']([^"']+)["']/)?.[1],
    resultHref: block.match(/\bAFF_URL\s*=\s*(['"])([^'"]+)\1/)?.[2],
    resultCta: 'Continue',
  });
  return out === html ? html : out.replace(block, '');
}

export function healClonedLander(html: string): HealResult {
  if (!html) return { html, applied: [], remaining: [] };
  const stepped = paceMessengerIntros(bakeMessengerSteps(html));
  const messenger = stepped !== html;
  let out = bakeCheckoutChampSnapshot(stepped);
  const baked = out !== html;
  const beforeVturb = out;
  out = repairVturbPlayer(out);
  const applied: string[] = [];
  if (messenger) applied.push('messenger-steps');
  if (baked) applied.push('cc-snapshot');
  if (out !== beforeVturb) applied.push('vturb-anchor');

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
