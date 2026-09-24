/**
 * Port of src/lib/popup-quiz-engine.ts for the OpenClaw worker (CJS).
 * Keep in sync with the TypeScript source.
 */

const STYLE_ID = 'wasabi-popup-quiz-style';
const SCRIPT_ID = 'wasabi-popup-quiz-engine';

function isPopupQuizHtml(html) {
  if (!html) return false;
  if (/\bid\s*=\s*["']ssqOverlay["']/i.test(html)) return true;
  if (/\bclass\s*=\s*["'][^"']*\bssq-overlay\b/i.test(html)) return true;
  if (/\bssqOverlay\b/.test(html) && /ssq-card/.test(html)) return true;
  if (/\bssq-inline\b/i.test(html) && /id=["']ssqBody["']/i.test(html)) return true;
  if (/id=["']ssqBody["']/i.test(html) && /ssq-card/.test(html) && /var\s+QS\s*=/.test(html)) return true;
  return false;
}

function popupQuizEditorRevealCss() {
  return (
    `<style data-editor-override id="${STYLE_ID}-editor">` +
    `.ssq-overlay{display:block!important;position:relative!important;inset:auto!important;background:rgba(12,10,35,.08)!important;padding:20px 12px 32px!important;z-index:1!important;overflow:visible!important;min-height:0!important}` +
    `.ssq-overlay .ssq-card{margin:0 auto;box-shadow:0 8px 28px rgba(0,0,0,.18)!important}` +
    `.esconder{display:block!important}` +
    `.ssq-inline{display:block!important}` +
    `.ssq-step,.ssq-step[hidden]{display:block!important;margin:0 0 22px;border:1px dashed #c5d0e0;padding:14px 12px;border-radius:12px}` +
    `.ssq-close{pointer-events:none}` +
    `</style>`
  );
}


const FALLBACK_QS = [
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

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function extractBalanced(src, start, open, close) {
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

function parseCfg(js) {
  const idx = js.search(/var\s+CFG\s*=\s*/);
  if (idx < 0) return {};
  const start = js.indexOf('{', idx);
  const raw = extractBalanced(js, start, '{', '}');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseJsStrings(blob) {
  const out = [];
  const re = /'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g;
  let m;
  while ((m = re.exec(blob))) {
    out.push((m[1] ?? m[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return out;
}

function field(obj, name) {
  const m = obj.match(new RegExp(`\\b${name}\\s*:\\s*(['"])([\\s\\S]*?)\\1`));
  return m?.[2] || '';
}

function parseQuestions(js) {
  let idx = js.search(/var\s+QS\s*=\s*CFG\.questions\s*\|\|/);
  if (idx < 0) idx = js.search(/var\s+QS\s*=\s*\[/);
  if (idx < 0) return FALLBACK_QS;
  const start = js.indexOf('[', idx);
  const raw = extractBalanced(js, start, '[', ']');
  if (!raw) return FALLBACK_QS;
  const chunks = [];
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
  const qs = [];
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

function parseProductImg(js) {
  const m = js.match(/var\s+PRODUCT_IMG\s*=\s*['"]([^'"]+)['"]/);
  return m?.[1] || '';
}

function decodeJsEscapes(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

function parseBetween(js, startMarker, endMarker) {
  const i = js.indexOf(startMarker);
  if (i < 0) return '';
  const from = i + startMarker.length;
  const j = js.indexOf(endMarker, from);
  if (j < 0) return '';
  return decodeJsEscapes(js.slice(from, j));
}

function fillCfgFromInlineQuiz(js, cfg) {
  if (!str(cfg.badge)) {
    const b = parseBetween(js, 'class="ssq-badge">', '</span>');
    if (b) cfg.badge = b;
  }
  if (!str(cfg.title)) {
    const t = parseBetween(js, 'class="ssq-restitle">', '</h3>');
    if (t) cfg.title = t;
  }
  if (!str(cfg.estBig)) {
    const t = parseBetween(js, 'class="big">', '</p>');
    if (t) cfg.estBig = t;
  }
  if (!str(cfg.estSub)) {
    const after = js.indexOf('class="big">');
    if (after >= 0) {
      const rest = js.slice(after, after + 800);
      const m = rest.match(/<\/p>\s*<p>([\s\S]*?)<\/p>/);
      if (m) cfg.estSub = decodeJsEscapes(m[1]);
    }
  }
  if (!str(cfg.cta)) {
    const m = js.match(/class="ssq-cta[^"]*"[^>]*>([^<]+)</);
    if (m) cfg.cta = decodeJsEscapes(m[1]);
  }
  if (!str(cfg.checkoutHref)) {
    const m = js.match(/bottles6\s*:\s*["'](https?:[^"']+)["']/);
    if (m) cfg.checkoutHref = m[1];
  }
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function materializeSteps(cfg, questions) {
  const parts = [];
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
      `<a class="ssq-cta buylink" id="ssqGo" href="${esc(str(cfg.checkoutHref) || '#')}">${cta}</a>` +
      `</div></div>`,
  );
  return parts.join('');
}

const ENGINE_JS = `(function(){
if(window.__wasabiPopupQuiz)return;
window.__wasabiPopupQuiz=1;
var ov=document.getElementById('ssqOverlay');
var root=ov||document.querySelector('.ssq-inline')||document.querySelector('.ssq-card')||document.getElementById('ssqBody');
if(!root)return;
var inline=!ov;
var card=root.querySelector?root.querySelector('.ssq-card'):null;
if(!card&&root.closest)card=root.closest('.ssq-card');
if(!card&&root.classList&&root.classList.contains('ssq-card'))card=root;
var prog=(root.querySelector&&root.querySelector('#ssqProg i'))||document.querySelector('#ssqProg i');
var steps=Array.prototype.slice.call((card||root).querySelectorAll('.ssq-step:not(.ssq-result)'));
var result=(card||root).querySelector('.ssq-step.ssq-result');
if(!steps.length)return;
var sel=(ov&&ov.getAttribute('data-ssq-cta'))||'a.cta-btn,a[href*="trk.donrephblog.com/click"],a[href*="/click"]';
var step=0,href='';
var go0=document.getElementById('ssqGo');
if(go0){href=go0.getAttribute('data-ssq-href')||go0.getAttribute('href')||'';if(href==='#')href='';}
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
  if(ov){ov.classList.add('open');document.body.style.overflow='hidden';}
  if(card)card.classList.remove('res');
  showStep(0);
}
function closeQuiz(){
  if(!ov)return;
  ov.classList.remove('open');
  document.body.style.overflow='';
  hideAll();
}
root.addEventListener('click',function(e){
  var t=e.target;if(!(t instanceof Element))return;
  if(t.id==='ssqClose'||t.classList.contains('ssq-close')){e.preventDefault();closeQuiz();return;}
  if(ov&&t===ov){closeQuiz();return;}
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
if(inline){
  showStep(0);
}else{
  document.addEventListener('click',function(e){
    try{
      var t=e.target;if(!(t instanceof Element))return;
      if(ov.contains(t))return;
      var a=t.closest(sel);
      if(!a)return;
      if(e.ctrlKey||e.metaKey||e.shiftKey||e.button===1)return;
      e.preventDefault();
      e.stopPropagation();
      openQuiz(a.getAttribute('data-ssq-href')||a.getAttribute('data-original-href')||a.getAttribute('href')||a.href||'');
    }catch(_){}
  },true);
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&ov.classList.contains('open'))closeQuiz();
  });
  var x=document.getElementById('ssqClose');
  if(x)x.onclick=function(e){e.preventDefault();closeQuiz();};
}
})();`;

function stripOriginalQuizScript(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (full) => {
    if (/wasabi-popup-quiz-engine/.test(full)) return full;
    if (/ssqOverlay|#ssqBody|ssq-overlay|var\s+QS\s*=/.test(full)) return '';
    return full;
  });
}

function injectBeforeClose(html, style, script) {
  let out = html.replace(
    /<(script|style)\b[^>]*\bid=["']wasabi-popup-quiz[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${style}</head>`);
  else out = `${style}${out}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${script}</body>`);
  return out + script;
}

function injectPopupQuizEngine(html) {
  if (!html || !isPopupQuizHtml(html)) return html;
  let out = stripOriginalQuizScript(html);

  if (!/data-ssq-step=/.test(out)) {
    const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
      .map((m) => m[1] || '')
      .join('\n');
    const cfg = parseCfg(scripts);
    fillCfgFromInlineQuiz(scripts, cfg);
    const img = parseProductImg(scripts);
    if (img && !str(cfg.productImg)) cfg.productImg = img;
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

  const inline = /\bssq-inline\b/.test(out) && !/\bid=["']ssqOverlay["']/.test(out);
  const style =
    `<style id="${STYLE_ID}">` +
    (inline
      ? `.esconder{display:block!important;visibility:visible!important}.ssq-inline{display:block!important}`
      : `.ssq-overlay{display:none}.ssq-overlay.open{display:block}`) +
    `.ssq-step[hidden]{display:none!important}` +
    `.ssq-inline{padding:6px 12px 20px}` +
    `.ssq-card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4eaf3;border-radius:18px;padding:34px 26px 30px;font-family:Poppins,Arial,sans-serif;color:#1d254b}` +
    `.ssq-progress{height:8px;background:#eef2f8;border-radius:99px;overflow:hidden;margin:0 0 22px}` +
    `.ssq-progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,#1d254b,#0a1c4e);border-radius:99px}` +
    `.ssq-opts{display:flex;flex-direction:column;gap:10px}` +
    `.ssq-opt{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:#f6f8fb;border:2px solid #d8e0ec;border-radius:12px;padding:14px 16px;font-size:15.5px;font-weight:600;cursor:pointer}` +
    `.ssq-opt.sel{border-color:#0a1c4e;background:#eef2f8}` +
    `.ssq-hint{font-size:13.5px;color:#657d96;margin:0 0 18px}` +
    `.ssq-continue,.ssq-cta{display:flex;align-items:center;justify-content:center;width:100%;margin:18px auto 0;padding:19px 22px;border:0;border-radius:8px;font-weight:800;background:#479c1a;color:#fff!important;text-decoration:none;cursor:pointer}` +
    `.ssq-back{display:block;margin:12px auto 0;background:none;border:0;color:#657d96;cursor:pointer}` +
    `.ssq-q{font-size:23px;font-weight:800;color:#0a1c4e;margin:0 0 6px}` +
    `.ssq-kicker{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#e19626;margin:0 0 8px}` +
    `.ssq-res{text-align:center}` +
    `.ssq-badge{display:inline-block;background:#eef2f8;border-radius:99px;padding:6px 12px;font-size:12px;font-weight:700}` +
    `.ssq-restitle{font-size:26px;color:#0a1c4e;margin:12px 0}` +
    `.ssq-est{background:#f6f8fb;border-radius:12px;padding:14px;margin:12px 0;text-align:left}` +
    `.ssq-est .big{font-size:22px;font-weight:800;color:#0a1c4e}` +
    `</style>`;
  const script = `<script id="${SCRIPT_ID}">${ENGINE_JS}</script>`;
  return injectBeforeClose(out, style, script);
}

module.exports = { isPopupQuizHtml, popupQuizEditorRevealCss, injectPopupQuizEngine };
