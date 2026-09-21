/**
 * SlimSoda-style CTA quiz popup (#ssqOverlay).
 *
 * The original page intercepts checkout CTAs, runs 5 questions in a modal,
 * then sends the same href. Clone/Swipe strips that JS (or the accordion
 * rescue steals the click), so the popup never opens and the questions
 * never exist as HTML to edit. We freeze the copy into the DOM and replay
 * the flow with a small engine.
 */

const STYLE_ID = 'wasabi-popup-quiz-style';
const SCRIPT_ID = 'wasabi-popup-quiz-engine';

export function isPopupQuizHtml(html: string): boolean {
  if (!html) return false;
  if (/\bid\s*=\s*["']ssqOverlay["']/i.test(html)) return true;
  if (/\bclass\s*=\s*["'][^"']*\bssq-overlay\b/i.test(html)) return true;
  if (/\bssqOverlay\b/.test(html) && /ssq-card/.test(html)) return true;
  return false;
}

export function popupQuizEditorRevealCss(): string {
  return (
    `<style data-editor-override id="${STYLE_ID}-editor">` +
    `.ssq-overlay{display:block!important;position:relative!important;inset:auto!important;background:rgba(12,10,35,.08)!important;padding:20px 12px 32px!important;z-index:1!important;overflow:visible!important;min-height:0!important}` +
    `.ssq-overlay .ssq-card{margin:0 auto;box-shadow:0 8px 28px rgba(0,0,0,.18)!important}` +
    `.ssq-step,.ssq-step[hidden]{display:block!important;margin:0 0 22px;border:1px dashed #c5d0e0;padding:14px 12px;border-radius:12px}` +
    `.ssq-close{pointer-events:none}` +
    `</style>`
  );
}

type Q = {
  k: string;
  q: string;
  hint?: string;
  multi?: boolean;
  e: string[];
  o: string[];
};

const FALLBACK_QS: Q[] = [
  {
    k: 'Step 1 of 5 – About You',
    q: 'What is your age range?',
    e: ['👩', '👩‍🦰', '👩‍🦱', '👩‍🦳', '👵'],
    o: ['Under 35', '35–44', '45–54', '55–64', '65+'],
  },
  {
    k: 'Step 2 of 5 – Symptoms',
    q: 'Which of these do you currently experience?',
    hint: 'Select all that apply – then hit Continue',
    multi: true,
    e: ['😴', '🫃', '🍫', '🌡️', '😟', '🔁', '✅'],
    o: [
      'Fatigue & low energy',
      'Belly bloating',
      'Sugar cravings',
      'Slow metabolism',
      'Mood swings',
      'Weight keeps coming back',
      'None of the above',
    ],
  },
  {
    k: 'Step 3 of 5 – Your Body',
    q: 'What is your current weight range?',
    e: ['⬇️', '↘️', '➡️', '↗️', '⬆️'],
    o: ['Under 140 lbs', '140–169 lbs', '170–199 lbs', '200–229 lbs', '230 lbs or more'],
  },
  {
    k: 'Step 4 of 5 – Your Body',
    q: 'How much weight would you like to lose in 90 days?',
    e: ['🎯', '🔥', '💎', '🚀'],
    o: ['5–25 lbs', '26–50 lbs', '51–80 lbs', '80+ lbs'],
  },
  {
    k: 'Step 5 of 5 – Your Experience',
    q: 'What have you already tried?',
    hint: 'Select all that apply – then hit Continue',
    multi: true,
    e: ['🥗', '🏃‍♀️', '🍬', '🥤', '💊', '💉', '🆕'],
    o: [
      'Diet or calorie-counting programs',
      'Exercise or workout plans',
      'Gummies, teas, or fat burners',
      'Baking soda water on its own',
      'Berberine or another single ingredient',
      'Weight-loss injections',
      'Nothing yet',
    ],
  },
];

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function extractBalanced(src: string, start: number, open: string, close: string): string | null {
  if (start < 0 || src[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function parseCfg(js: string): Record<string, unknown> {
  const idx = js.search(/var\s+CFG\s*=\s*/);
  if (idx < 0) return {};
  const start = js.indexOf('{', idx);
  const raw = extractBalanced(js, start, '{', '}');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsStrings(blob: string): string[] {
  const out: string[] = [];
  const re = /'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) {
    out.push((m[1] ?? m[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return out;
}

function field(obj: string, name: string): string {
  const m = obj.match(new RegExp(`\\b${name}\\s*:\\s*(['"])([\\s\\S]*?)\\1`));
  return m?.[2] || '';
}

function parseQuestions(js: string): Q[] {
  const idx = js.search(/var\s+QS\s*=\s*CFG\.questions\s*\|\|/);
  if (idx < 0) return FALLBACK_QS;
  const start = js.indexOf('[', idx);
  const raw = extractBalanced(js, start, '[', ']');
  if (!raw) return FALLBACK_QS;
  const chunks: string[] = [];
  let depth = 0;
  let from = 1;
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < raw.length && raw[i] !== q) {
        if (raw[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === '{') {
      if (depth === 0) from = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) chunks.push(raw.slice(from, i + 1));
    }
  }
  const qs: Q[] = [];
  for (const chunk of chunks) {
    const oMatch = chunk.match(/\bo\s*:\s*\[([\s\S]*?)\]/);
    const eMatch = chunk.match(/\be\s*:\s*\[([\s\S]*?)\]/);
    const o = oMatch ? parseJsStrings(oMatch[1]) : [];
    if (!o.length) continue;
    qs.push({
      k: field(chunk, 'k'),
      q: field(chunk, 'q') || 'Question',
      hint: field(chunk, 'hint') || undefined,
      multi: /\bmulti\s*:\s*true\b/.test(chunk),
      e: eMatch ? parseJsStrings(eMatch[1]) : [],
      o,
    });
  }
  return qs.length ? qs : FALLBACK_QS;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function materializeSteps(cfg: Record<string, unknown>, questions: Q[]): string {
  const parts: string[] = [];
  questions.forEach((Q, i) => {
    const opts = Q.o
      .map((label, j) => {
        const emo = Q.e[j] ? `<span class="ssq-emo">${esc(Q.e[j])}</span>` : '';
        return `<button type="button" class="ssq-opt" data-i="${j}">${emo}<span class="ssq-lbl">${esc(label)}</span></button>`;
      })
      .join('');
    const pre =
      i === 0 && str(cfg.preamble)
        ? `<p class="ssq-pre">${str(cfg.preamble)}</p>`
        : '';
    const hint = Q.hint ? `<p class="ssq-hint">${esc(Q.hint)}</p>` : '';
    const cont = Q.multi
      ? `<button type="button" class="ssq-continue" data-ssq-continue disabled>Continue →</button>`
      : '';
    const back =
      i > 0 ? `<button type="button" class="ssq-back" data-ssq-back>← Back</button>` : '';
    parts.push(
      `<div class="ssq-step" data-ssq-step="${i}" data-multi="${Q.multi ? '1' : '0'}" hidden>` +
        pre +
        `<p class="ssq-kicker">${esc(Q.k)}</p>` +
        `<h3 class="ssq-q">${esc(Q.q)}</h3>` +
        hint +
        `<div class="ssq-opts">${opts}</div>` +
        cont +
        back +
        `</div>`,
    );
  });
  const badge = str(cfg.badge) || '✨ Congratulations — your result is ready';
  const title = str(cfg.title) || 'You’re a perfect match!';
  const estBig = str(cfg.estBig) || '';
  const estSub = str(cfg.estSub) || '';
  const unlock = str(cfg.unlock) || '';
  const cta = str(cfg.cta) || 'Continue →';
  const img = str(cfg.productImg);
  const scarce = str(cfg.scarce);
  parts.push(
    `<div class="ssq-step ssq-result" data-ssq-step="result" hidden>` +
      `<div class="ssq-res">` +
      `<span class="ssq-badge">${badge}</span>` +
      `<h3 class="ssq-restitle">${title}</h3>` +
      (estBig
        ? `<div class="ssq-est"><h4>📊 Your estimated results</h4><p class="big">${estBig}</p><p>${estSub}</p></div>`
        : '') +
      (img ? `<div class="ssq-prod"><img src="${esc(img)}" alt="" loading="lazy"></div>` : '') +
      scarce +
      (unlock ? `<p class="ssq-unlock">${unlock}</p>` : '') +
      `<a class="ssq-cta" id="ssqGo" href="#">${cta}</a>` +
      `</div></div>`,
  );
  return parts.join('');
}

const ENGINE_JS = `(function(){
if(window.__wasabiPopupQuiz)return;
window.__wasabiPopupQuiz=1;
var ov=document.getElementById('ssqOverlay');
if(!ov)return;
var body=document.getElementById('ssqBody')||ov.querySelector('#ssqBody');
var card=ov.querySelector('.ssq-card');
var prog=ov.querySelector('#ssqProg i');
var steps=Array.prototype.slice.call(ov.querySelectorAll('.ssq-step:not(.ssq-result)'));
var result=ov.querySelector('.ssq-step.ssq-result');
if(!steps.length)return;
var sel=ov.getAttribute('data-ssq-cta')||'a.cta-btn,a[href*="trk.donrephblog.com/click"],a[href*="/click"]';
var step=0,href='';
function setProg(p){if(prog)prog.style.width=p+'%';}
function hideAll(){
  steps.forEach(function(el){el.hidden=true;el.style.display='none';});
  if(result){result.hidden=true;result.style.display='none';}
}
function showStep(i){
  hideAll();
  step=i;
  var el=steps[i];
  if(!el){showResult();return;}
  el.hidden=false;el.style.display='block';
  setProg((i/steps.length)*100);
  el.querySelectorAll('.ssq-opt.sel').forEach(function(b){b.classList.remove('sel');});
  var cont=el.querySelector('[data-ssq-continue]');
  if(cont)cont.disabled=true;
}
function showResult(){
  hideAll();
  if(card)card.classList.add('res');
  if(result){result.hidden=false;result.style.display='block';}
  setProg(100);
  var go=document.getElementById('ssqGo');
  if(go&&href)go.setAttribute('href',href);
}
function openQuiz(h){
  href=h||href;
  ov.classList.add('open');
  document.body.style.overflow='hidden';
  if(card)card.classList.remove('res');
  showStep(0);
}
function closeQuiz(){
  ov.classList.remove('open');
  document.body.style.overflow='';
  hideAll();
}
ov.addEventListener('click',function(e){
  var t=e.target;if(!(t instanceof Element))return;
  if(t.id==='ssqClose'||t.classList.contains('ssq-close')){e.preventDefault();closeQuiz();return;}
  if(t===ov){closeQuiz();return;}
  var back=t.closest('[data-ssq-back]');
  if(back){e.preventDefault();showStep(Math.max(0,step-1));return;}
  var cont=t.closest('[data-ssq-continue]');
  if(cont){e.preventDefault();showStep(step+1);return;}
  var opt=t.closest('.ssq-opt');
  if(!opt)return;
  e.preventDefault();
  var panel=opt.closest('.ssq-step');
  if(!panel)return;
  var multi=panel.getAttribute('data-multi')==='1';
  if(multi){
    opt.classList.toggle('sel');
    var any=panel.querySelector('.ssq-opt.sel');
    var c=panel.querySelector('[data-ssq-continue]');
    if(c)c.disabled=!any;
  }else{
    opt.classList.add('sel');
    setTimeout(function(){showStep(step+1);},180);
  }
},true);
document.addEventListener('click',function(e){
  try{
    var t=e.target;if(!(t instanceof Element))return;
    if(ov.contains(t))return;
    var a=t.closest(sel);
    if(!a)return;
    if(e.ctrlKey||e.metaKey||e.shiftKey||e.button===1)return;
    e.preventDefault();
    e.stopPropagation();
    openQuiz(a.getAttribute('href')||a.href||'');
  }catch(_){}
},true);
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&ov.classList.contains('open'))closeQuiz();
});
var x=document.getElementById('ssqClose');
if(x)x.onclick=function(e){e.preventDefault();closeQuiz();};
})();`;

function stripOriginalQuizScript(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (full) => {
    if (/wasabi-popup-quiz-engine/.test(full)) return full;
    if (/ssqOverlay|#ssqBody|ssq-overlay/.test(full)) return '';
    return full;
  });
}

function injectBeforeClose(html: string, style: string, script: string): string {
  let out = html.replace(
    /<(script|style)\b[^>]*\bid=["']wasabi-popup-quiz[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${style}</head>`);
  else out = `${style}${out}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${script}</body>`);
  return out + script;
}

export function injectPopupQuizEngine(html: string): string {
  if (!html || !isPopupQuizHtml(html)) return html;
  let out = stripOriginalQuizScript(html);

  if (!/data-ssq-step=/.test(out)) {
    const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
      .map((m) => m[1] || '')
      .filter((t) => /ssqOverlay/.test(t))
      .join('\n');
    const cfg = parseCfg(scripts);
    const questions = parseQuestions(scripts);
    const inner = materializeSteps(cfg, questions);
    if (/id=["']ssqBody["'][^>]*>\s*</i.test(out)) {
      out = out.replace(
        /(<div\b[^>]*id=["']ssqBody["'][^>]*>)([\s\S]*?)(<\/div>)/i,
        `$1${inner}$3`,
      );
    } else if (/id=["']ssqBody["']/.test(out)) {
      out = out.replace(
        /<div\b[^>]*id=["']ssqBody["'][^>]*>/i,
        (open) => `${open}${inner}`,
      );
    }
    if (!/\bdata-ssq-cta=/.test(out)) {
      out = out.replace(
        /(<div\b[^>]*id=["']ssqOverlay["'][^>]*)>/i,
        '$1 data-ssq-cta="a.cta-btn, a[href*=\'/click\']">',
      );
    }
  }

  const style =
    `<style id="${STYLE_ID}">` +
    `.ssq-overlay{display:none}` +
    `.ssq-overlay.open{display:block}` +
    `.ssq-step[hidden]{display:none!important}` +
    `</style>`;
  const script = `<script id="${SCRIPT_ID}">${ENGINE_JS}</script>`;
  return injectBeforeClose(out, style, script);
}
