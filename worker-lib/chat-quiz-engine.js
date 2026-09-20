/**
 * Port of src/lib/chat-quiz-engine.ts for the OpenClaw worker (CJS).
 * Keep in sync with the TypeScript source.
 */

function isChatQuizHtml(html) {
  if (!html) return false;
  return (
    /data-next-chat\s*=/i.test(html) ||
    /\bid\s*=\s*["']chatbox-app["']/i.test(html) ||
    /function\s+displayMessages\s*\(/i.test(html) ||
    /landerlab\.io/i.test(html) ||
    /class\s*=\s*["'][^"']*\bchatbox\b[^"']*["'][^>]*data-step\s*=/i.test(html)
  );
}

function restoreQuizCtas(html) {
  return html.replace(
    /<a\b([^>]*?\b(?:quiz-results-cta|mobile-sticky-bar)\b[^>]*)>/gi,
    (full, attrs) => {
      const orig = attrs.match(/\bdata-original-href\s*=\s*(["'])([^"']*)\1/i);
      if (!orig || !orig[2]) return full;
      const href = orig[2].replace(/"/g, '&quot;');
      const next = /\bhref\s*=/i.test(attrs)
        ? attrs.replace(/\bhref\s*=\s*(["'])[^"']*\1/i, `href="${href}"`)
        : `${attrs} href="${href}"`;
      return `<a${next}>`;
    },
  );
}

const ENGINE_JS = `(function(){
if(window.__wasabiChatQuiz)return;
window.__wasabiChatQuiz=1;
function q(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}
function show(el){
  if(!el)return;
  el.classList.remove('nodisplay');
  el.style.removeProperty('display');
}
function hide(el){
  if(!el)return;
  el.classList.add('nodisplay');
  el.style.removeProperty('display');
}
function scrollToEl(el){
  if(!el)return;
  try{el.scrollIntoView({behavior:'smooth',block:'end'});}catch(e){
    try{el.scrollIntoView(false);}catch(_){}
  }
}
function displayMessages(total,step,cb){
  var box=document.querySelector('.chatbox.bot-reply[data-step="'+step+'"]');
  if(!box){if(cb)cb();return;}
  show(box);
  var reply=box.querySelector('.chatbox-message.reply');
  if(reply){reply.classList.remove('nodisplay');reply.style.removeProperty('display');}
  var n=Math.max(1,parseInt(String(total||box.getAttribute('data-total-steps')||'1'),10)||1);
  var i=1;
  function tick(){
    var msg=box.querySelector('.chatbox-message[data-steps="'+i+'"]');
    if(msg)show(msg);
    scrollToEl(box);
    if(i>=n){
      if(reply)hide(reply);
      if(cb)cb();
      return;
    }
    i++;
    setTimeout(tick,850);
  }
  setTimeout(tick,200);
}
function runLoading(){
  var loading=document.getElementById('quiz-loading');
  var results=document.getElementById('quiz-results');
  var stats=q('.quiz-loading-stat');
  var bar=document.getElementById('quiz-loading-bar');
  var pctEl=document.getElementById('quiz-loading-pct');
  if(loading)show(loading);
  stats.forEach(function(el){el.classList.remove('visible');});
  if(bar)bar.style.width='0%';
  if(pctEl)pctEl.textContent='0';
  scrollToEl(loading);
  var reveal=[600,1300,2000,2800];
  stats.forEach(function(el,idx){
    setTimeout(function(){el.classList.add('visible');},reveal[idx]||600);
  });
  var duration=3600,start=Date.now();
  var tick=setInterval(function(){
    var pct=Math.min(100,Math.round(((Date.now()-start)/duration)*100));
    if(bar)bar.style.width=pct+'%';
    if(pctEl)pctEl.textContent=String(pct);
    if(pct>=100){
      clearInterval(tick);
      setTimeout(function(){
        hide(loading);
        if(results)show(results);
        var sticky=document.getElementById('mobile-sticky-bar')||document.querySelector('.mobile-sticky-bar');
        if(sticky)sticky.classList.add('force-show');
        if(document.body)document.body.classList.add('has-sticky-bar');
        scrollToEl(results);
      },250);
    }
  },60);
}
function reset(){
  q('.chatbox.user-reply').forEach(hide);
  q('.quiz-panel').forEach(hide);
  q('.chatbox.bot-reply').forEach(function(box){
    var step=box.getAttribute('data-step');
    q('.chatbox-message[data-steps]',box).forEach(hide);
    var reply=box.querySelector('.chatbox-message.reply');
    if(reply)hide(reply);
    if(step==='1'){box.classList.remove('nodisplay');box.style.removeProperty('display');}
    else hide(box);
  });
}
function onClick(ev){
  var t=ev.target;
  if(!t||!t.closest)return;
  var btn=t.closest('.chat-button');
  if(!btn)return;
  ev.preventDefault();
  ev.stopPropagation();
  var replyStep=btn.getAttribute('data-form-step-reply');
  var next=btn.getAttribute('data-next-chat');
  var replyText=btn.getAttribute('data-form-value')||(btn.textContent||'').trim();
  var tone=btn.getAttribute('data-answer-tone');
  var block=btn.closest('.chat-btn-block');
  if(block)hide(block);
  var user=document.querySelector('.chatbox.user-reply[data-step-reply="'+replyStep+'"]');
  if(user){
    show(user);
    var bubble=user.querySelector('.chatbox-message');
    if(bubble){
      bubble.classList.remove('answer-reply-yes','answer-reply-no');
      bubble.textContent=replyText;
      if(tone)bubble.classList.add('answer-reply-'+tone);
      show(bubble);
    }
  }
  if(next==='loading'){runLoading();return;}
  var nextBox=document.querySelector('.chatbox.bot-reply[data-step="'+next+'"]');
  if(!nextBox)return;
  show(nextBox);
  displayMessages(nextBox.getAttribute('data-total-steps'),next);
}
function start(){
  reset();
  var first=document.querySelector('.chatbox.bot-reply[data-step="1"]');
  displayMessages(first&&first.getAttribute('data-total-steps')||5,1);
  document.addEventListener('click',onClick,true);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);
else start();
})();`;

function injectChatQuizEngine(html) {
  if (!html || !isChatQuizHtml(html)) return html;

  let out = html
    .replace(/<(script|style)\b[^>]*\bid=["']wasabi-chat-quiz[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<script\b[^>]*\bsrc=["'][^"']*landerlab[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?\bfunction\s+displayMessages\s*\([\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?\b(?:LL_VARIANT_ID|LL_LANDER_ID|reportConversion|llQueryStrings|llMacros)\b[\s\S]*?<\/script>/gi, '');

  out = restoreQuizCtas(out);

  const style = '<style id="wasabi-chat-quiz-style">.nodisplay{display:none!important}</style>';
  const script = `<script id="wasabi-chat-quiz-engine">${ENGINE_JS}</script>`;

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${style}</head>`);
  } else if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/(<head\b[^>]*>)/i, `$1${style}`);
  } else {
    out = `${style}${out}`;
  }

  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${script}</body>`);
  }
  return out + script;
}

module.exports = { isChatQuizHtml, injectChatQuizEngine };
