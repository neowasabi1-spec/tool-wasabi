// worker-lib/finalize.js
//
// Port JS puro di src/app/api/landing/swipe/openclaw-finalize/route.ts.
// Applica i rewrite all'HTML originale ZERO chiamate HTTP a Netlify.
//
// Input:
//   { html, sourceUrl?, texts: [{id,original,tag}], rewrites: [{id,rewritten}] }
// Output: stessa shape che ritornava la route Netlify.

function escRxLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Distribuisce `newText` proporzionalmente tra i segmenti di testo `textSegments`
// (riferimenti index nell'array `segments` derivato da split('/(<[^>]+>)/')),
// preservando la posizione e la quantita' relativa dei tag inline (bold, link,
// br, ecc.). Porting dell'algoritmo della Deno function clone-competitor.
function distributeTextProportionally(segments, textSegments, newText) {
  if (textSegments.length <= 1) {
    if (textSegments.length === 1) segments[textSegments[0].index] = newText;
    return;
  }
  const originalWordCounts = textSegments.map((ts) => {
    const words = ts.content.trim().split(/\s+/).filter((w) => w.length > 0);
    return Math.max(1, words.length);
  });
  const totalOriginalWords = originalWordCounts.reduce((a, b) => a + b, 0);
  const newWords = newText.trim().split(/\s+/).filter((w) => w.length > 0);
  if (totalOriginalWords === 0 || newWords.length === 0) {
    segments[textSegments[0].index] = newText;
    for (let si = 1; si < textSegments.length; si++) segments[textSegments[si].index] = '';
    return;
  }
  let wordIdx = 0;
  for (let si = 0; si < textSegments.length; si++) {
    const cumulativeRatio =
      originalWordCounts.slice(0, si + 1).reduce((a, b) => a + b, 0) / totalOriginalWords;
    const cumulativeTarget = Math.round(cumulativeRatio * newWords.length);
    const wordsForThis = Math.max(0, cumulativeTarget - wordIdx);
    if (wordsForThis > 0 && wordIdx < newWords.length) {
      const segmentWords = newWords.slice(wordIdx, wordIdx + wordsForThis).join(' ');
      const hadLeadingSpace = /^\s/.test(textSegments[si].content);
      segments[textSegments[si].index] = (hadLeadingSpace && si > 0 ? ' ' : '') + segmentWords;
      wordIdx += wordsForThis;
    } else {
      segments[textSegments[si].index] = '';
    }
  }
  if (wordIdx < newWords.length) {
    const lastIdx = textSegments[textSegments.length - 1].index;
    const remaining = newWords.slice(wordIdx).join(' ');
    segments[lastIdx] = segments[lastIdx] ? segments[lastIdx] + ' ' + remaining : remaining;
  }
}

// Sostituisce placeholder Liquid/Jinja noti con valori reali. Senza questa
// pass, "{{MMMM dd, yyyy}}", "{{Location}}" restano letterali nel preview.
function replaceLiquidPlaceholders(html) {
  const now = new Date();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fullDate = `${monthNames[now.getMonth()]} ${String(now.getDate()).padStart(2,'0')}, ${now.getFullYear()}`;
  const shortDate = `${monthShort[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  return html
    .replace(/\{\{\s*MMMM\s+dd,?\s+yyyy\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*MMM\s+dd,?\s+yyyy\s*\}\}/gi, shortDate)
    .replace(/\{\{\s*dd[\/\-]MM[\/\-]yyyy\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*yyyy[\/\-]MM[\/\-]dd\s*\}\}/gi, now.toISOString().substring(0, 10))
    .replace(/\{\{\s*today\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*current[\s_-]?date\s*\}\}/gi, fullDate)
    .replace(/\{\{\s*day[\s_-]?name\s*\}\}/gi, dayName)
    .replace(/\{\{\s*[Ll]ocation\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ity\s*\}\}/g, '')
    .replace(/\{\{\s*[Cc]ountry\s*\}\}/g, '');
}

// Fuzzy replace tag-tolerante: prova a trovare l'originale anche quando in
// HTML e' spezzato da tag inline (<strong>, <em>, <span>, <br>, ecc.) o
// contiene &nbsp;. Quando trova un match, distribuisce il nuovo testo
// proporzionalmente sui segmenti di testo preservando ESATTAMENTE i tag.
// Ritorna { html, replaced } con replaced=true se almeno un'occorrenza e'
// stata sostituita.
function fuzzyReplaceWithTagPreservation(html, originalText, newText) {
  if (!originalText || !newText || originalText === newText) return { html, replaced: false };
  if (originalText.length < 5 || originalText.length > 600) return { html, replaced: false };
  const words = originalText.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2 || words.length > 40) return { html, replaced: false };
  let result = html;
  let replaced = false;
  try {
    const escapedWords = words.map((w) => escRxLiteral(w));
    const tagsBetween = '(?:\\s|&nbsp;|<[^>]{0,200}>)*';
    const pattern = escapedWords.join(tagsBetween);
    const regex = new RegExp(pattern, 'i');
    const match = result.match(regex);
    if (match) {
      const matchedStr = match[0];
      const tagsInMatch = matchedStr.match(/<[^>]+>/g) || [];
      if (tagsInMatch.length > 0) {
        const segments = matchedStr.split(/(<[^>]+>)/);
        const textSegments = [];
        for (let si = 0; si < segments.length; si++) {
          if (segments[si] && !segments[si].startsWith('<')) {
            textSegments.push({ index: si, content: segments[si] });
          }
        }
        if (textSegments.length > 0) {
          distributeTextProportionally(segments, textSegments, newText);
          const replacement = segments.join('');
          result = result.substring(0, match.index) + replacement + result.substring(match.index + matchedStr.length);
          replaced = true;
        } else {
          const preservedTags = tagsInMatch.join('');
          result = result.substring(0, match.index) + newText + preservedTags + result.substring(match.index + matchedStr.length);
          replaced = true;
        }
      } else {
        result = result.substring(0, match.index) + newText + result.substring(match.index + matchedStr.length);
        replaced = true;
      }
    }
  } catch { /* regex invalida (improbabile, escape ok), skip */ }
  return { html: result, replaced };
}

// Estrae candidati brand dal dominio: try.nooro-us.com → ['nooro-us','nooro','us']
function extractBrandCandidatesFromDomain(sourceUrl) {
  const out = [];
  if (!sourceUrl) return out;
  try {
    const urlObj = new URL(sourceUrl);
    const host = urlObj.hostname.replace(/^www\./, '').toLowerCase();
    const parts = host.split('.');
    const twoLevelTlds = new Set(['co.uk','co.nz','com.au','com.br','co.jp','co.in']);
    let sldIdx = parts.length - 2;
    if (parts.length >= 3 && twoLevelTlds.has(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`)) {
      sldIdx = parts.length - 3;
    }
    const sld = parts[sldIdx];
    if (sld && sld.length >= 3) {
      out.push(sld);
      if (sld.includes('-')) for (const piece of sld.split('-')) if (piece.length >= 3) out.push(piece);
    }
    for (let i = 0; i < sldIdx; i++) {
      const sub = parts[i];
      if (sub.length >= 4 && !['try','app','www','shop','store','go','buy','get','my','web'].includes(sub)) {
        out.push(sub);
      }
    }
  } catch {/* invalid url */}
  return out;
}

// Sostituisce il brand del competitor (estratto dal dominio e dal <title>
// originale) con il nuovo nome prodotto, SOLO nei text-node (non in style/
// script/noscript) e con guard sui TLD per non rompere URL.
function replaceBrandInHtml(html, sourceUrl, originalHtml, productName) {
  if (!productName || !sourceUrl) return html;
  const brandsToReplace = [];
  brandsToReplace.push(...extractBrandCandidatesFromDomain(sourceUrl));
  const titleMatch = (originalHtml || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const titleParts = titleMatch[1].trim().split(/\s*[-|:–—]\s*/);
    for (const part of titleParts) {
      const t = part.trim();
      if (t.length > 3 && t.length < 40 && t.toLowerCase() !== productName.toLowerCase()) brandsToReplace.push(t);
    }
  }
  const ogMatch = (originalHtml || '').match(/property=["']og:site_name["']\s*content=["']([^"']+)["']/i)
    || (originalHtml || '').match(/content=["']([^"']+)["']\s*property=["']og:site_name["']/i);
  if (ogMatch && ogMatch[1].trim().length > 3) brandsToReplace.push(ogMatch[1].trim());

  const productLower = productName.toLowerCase();
  const productTokensLower = new Set(productName.split(/\s+/).map((t) => t.toLowerCase()).filter(Boolean));
  const uniqueBrands = [...new Set(brandsToReplace.map((b) => b.trim()))]
    .filter((b) => b.length >= 5)
    .filter((b) => b.toLowerCase() !== productLower)
    .filter((b) => !productTokensLower.has(b.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (uniqueBrands.length === 0) return html;

  const protectedBlocks = [];
  let working = html.replace(/<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const idx = protectedBlocks.length; protectedBlocks.push(m); return `\u0000PROTECTED_BRAND_${idx}\u0000`;
  });
  const TLD_GUARD = `(?!\\.(?:com|org|net|io|co|us|uk|de|fr|es|it|me|info|ai|app|shop|store|biz|tv|live|xyz|pro|club|space|website))`;
  const htmlParts = working.split(/(<[^>]+>)/);
  for (let i = 0; i < htmlParts.length; i++) {
    if (!htmlParts[i].startsWith('<')) {
      for (const brand of uniqueBrands) {
        const escaped = escRxLiteral(brand);
        htmlParts[i] = htmlParts[i].replace(
          new RegExp(`(^|[^a-zA-Z0-9])${escaped}(?=[^a-zA-Z0-9]|$)${TLD_GUARD}`, 'gi'),
          (_m, prefix) => `${prefix}${productName}`,
        );
      }
    }
  }
  working = htmlParts.join('');
  working = working.replace(/\u0000PROTECTED_BRAND_(\d+)\u0000/g, (_m, idx) => protectedBlocks[Number(idx)] ?? '');
  return working;
}

// Detect SPA: pagine costruite con Vue (data-v-*), React (data-reactroot,
// __NEXT_DATA__), Svelte (svelte-*), Nuxt (__NUXT__), o page builders che
// compilano a un componente (Funnelytics, ClickFunnels 2.0, Convertri,
// Shogun, Replo) si idratano dopo il render. Se il rewrite introduce nuovi
// tag (<p>, <strong>, <br>) che non c'erano nell'originale, il mismatch
// di hydration fa bail al framework e DISABILITA tutti gli event handler:
// accordion FAQ, slider, gallery, modali smettono di rispondere ai click
// pur continuando a renderizzare. Detection cheap su un sample 50KB.
function detectSpa(originalHtml) {
  if (!originalHtml || typeof originalHtml !== 'string') return false;
  const sample = originalHtml.substring(0, 50000);
  return (
    /\bdata-v-[a-f0-9]{6,}/.test(sample) ||
    /\bdata-reactroot\b/.test(sample) ||
    /__NEXT_DATA__/.test(sample) ||
    /__NUXT__/.test(sample) ||
    /__sveltekit_data/.test(sample) ||
    /\bsvelte-[a-z0-9]{6,}/.test(sample) ||
    /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/.test(sample) ||
    /<div[^>]+id=["']__next["'][^>]*>/.test(sample) ||
    /\bv-cloak\b/.test(sample) ||
    /\bng-(?:app|controller|view)\b/.test(sample)
  );
}

// Rimuove tutti i tag HTML da un rewrite mantenendo solo il testo.
// Usato quando l'originale era plain text ma il LLM ha aggiunto markup
// (problema tipico su SPA: rompe l'hydration).
function stripAllHtmlTags(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// SPA safety: garantisce che il rewrite NON cambi la struttura dei tag
// rispetto all'originale.
//   - originale plain + rewrite con tag → strip tag dal rewrite
//   - originale con tag + rewrite con tag → fallback a plain (non riusciamo
//     a riallineare i tag, meglio perdere formattazione che rompere hydration)
//   - originale con tag + rewrite plain → ok, distributeTextProportionally
//     ridistribuira' il testo sui segmenti preservando i tag originali
function enforceSpaSafety(originalText, rewrittenText) {
  const originalHasTags = /<[a-zA-Z\/]/.test(originalText || '');
  const rewrittenHasTags = /<[a-zA-Z\/]/.test(rewrittenText || '');
  if (!rewrittenHasTags) return rewrittenText;
  // rewritten ha tag → strip in entrambi i casi (sia se originalHasTags
  // sia se non li aveva; nel primo caso preserveremo i tag originali via
  // distributeTextProportionally durante il fuzzy replace).
  return stripAllHtmlTags(rewrittenText);
}

// Collassa run consecutive del product name ("Reset Patch Reset Patch" →
// "Reset Patch") dentro lo stesso text-node. Mai cross-tag (rompe handler).
function collapseConsecutiveBrandRuns(html, productName) {
  if (!productName || productName.length < 3) return html;
  const escaped = escRxLiteral(productName);
  const gap = `(?:[\\s\\u00A0]|&nbsp;|&\\#160;|[\\-–—:|·•†*])*`;
  const dup = new RegExp(`(${escaped})${gap}\\1`, 'gi');
  const protectedBlocks = [];
  let working = html.replace(/<(style|script|noscript)[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    const idx = protectedBlocks.length; protectedBlocks.push(m); return `\u0000PROTECTED_COLLAPSE_${idx}\u0000`;
  });
  const segments = working.split(/(<[^>]+>)/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg.startsWith('<')) continue;
    let prev = seg;
    for (let pass = 0; pass < 6; pass++) {
      const next = prev.replace(dup, '$1');
      if (next === prev) break;
      prev = next;
    }
    segments[i] = prev;
  }
  working = segments.join('');
  working = working.replace(/\u0000PROTECTED_COLLAPSE_(\d+)\u0000/g, (_m, idx) => protectedBlocks[Number(idx)] ?? '');
  return working;
}

// Strip <script>, <noscript> e attributi inline on* dall'HTML. Mantiene
// gli script che hanno l'attributo data-fallback (i nostri injection).
// Usato in spa-preview-mode per evitare che il bundle Vue/Funnelish/
// CheckoutChamp originale tenti di montare contro un dominio che non e'
// il suo (manca sessione, API, ecc.) lasciando i bottoni inerti.
function stripOriginalScripts(html) {
  let out = html;
  const before = (out.match(/<script\b/gi) || []).length;
  out = out.replace(/<script\b(?![^>]*data-fallback=)(?![^>]*data-inlined-bundle=)[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b(?![^>]*data-fallback=)(?![^>]*data-inlined-bundle=)[^>]*\/>/gi, '');
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  out = out.replace(/\s+on[a-z]+="[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+='[^']*'/gi, '');
  const after = (out.match(/<script\b/gi) || []).length;
  return { html: out, scriptsBefore: before, scriptsAfter: after };
}

// Fix navigation Next.js: i quiz Next.js fanno fetch a
// /_next/data/<buildId>/<page>.json per props della pagina successiva.
// Su un dominio clonato questi danno 404 → quiz si blocca al primo click.
// Monkey-patch del fetch per ritornare pageProps:{} (lo state del
// componente quiz mantiene comunque la domanda corrente).
const NEXTJS_NAVIGATION_FIX = `<script data-fallback="navigation-fix">(function(){
  if (typeof window === 'undefined') return;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;
  window.fetch = function(input, init){
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\\/_next\\/data\\//.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({pageProps:{},__N_SSP:true}),{status:200,headers:{'Content-Type':'application/json'}}));
      }
    } catch(e){}
    return origFetch(input, init);
  };
})();</script>`;

// CSS hard-override per FAQ/accordion. Strategia pragmatica: tutte le FAQ
// visibili DI DEFAULT (no JS necessario per leggerle). Il toggle JS
// nostro aggiunge/rimuove .fb-collapsed per richiuderle. Specificity alta
// per battere Vue scoped CSS [data-v-*].
const FAQ_CSS_OVERRIDE = `<style data-fallback="faq-css">
html body .faq .faq-content-wrapper,html body .faq .faq-content,html body .faq-wrapper .faq-content-wrapper,html body .faq-wrapper .faq-content,html body .faq-item .faq-body,html body .faq-item .faq-answer,html body .accordion-item .accordion-content,html body .accordion-item .accordion-body,html body .accordion-item .accordion-collapse,html body details > *:not(summary){display:block !important;max-height:none !important;height:auto !important;min-height:0 !important;overflow:visible !important;visibility:visible !important;opacity:1 !important;transform:none !important;pointer-events:auto !important;}
html body .faq.fb-collapsed .faq-content-wrapper,html body .faq.fb-collapsed .faq-content,html body .faq-wrapper.fb-collapsed .faq-content-wrapper,html body .faq-wrapper.fb-collapsed .faq-content,html body .faq-item.fb-collapsed .faq-body,html body .faq-item.fb-collapsed .faq-answer,html body .accordion-item.fb-collapsed .accordion-content,html body .accordion-item.fb-collapsed .accordion-body{display:none !important;}
.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,.accordion-question,.accordion-toggle,summary{cursor:pointer !important;}
.fb-icon-rotated{transform:rotate(180deg) !important;transition:transform .2s !important;}
html body .stickSection{display:block !important;visibility:visible !important;opacity:1 !important;}
</style>`;

// Fallback init server-side: jQuery + Swiper da CDN se mancano, FAQ
// accordion delegato, thumb→main image binding, sticky CTA visibili.
// Idempotente: window.__FB_FALLBACK_INSTALLED segna l'installazione.
const FALLBACK_INIT_SCRIPT = `<script data-fallback="init">(function(){
  var FB_VERSION='worker-finalize-v1';
  if(window.__FB_FALLBACK_INSTALLED){return;} window.__FB_FALLBACK_INSTALLED=FB_VERSION;
  function loadCss(href){if(document.querySelector('link[data-fb-css="'+href+'"]'))return;var l=document.createElement('link');l.rel='stylesheet';l.href=href;l.dataset.fbCss=href;document.head.appendChild(l);}
  function loadScript(src,cb){var existing=document.querySelector('script[data-fb-src="'+src+'"]');if(existing){if(existing.__loaded){cb();}else{existing.addEventListener('load',cb);existing.addEventListener('error',cb);}return;}var s=document.createElement('script');s.src=src;s.async=false;s.dataset.fbSrc=src;s.addEventListener('load',function(){s.__loaded=true;cb();});s.addEventListener('error',function(){cb();});(document.head||document.documentElement).appendChild(s);}
  function findContents(header){var p=header.closest('.faq,.faq-wrapper,.faq-item,.accordion-item,details')||header.parentElement;return p;}
  function toggleFaq(header){var p=findContents(header);if(!p)return;var willCollapse=!p.classList.contains('fb-collapsed');if(willCollapse){p.classList.add('fb-collapsed');p.classList.remove('active','open','expanded','is-open','show');if(p.tagName==='DETAILS')p.removeAttribute('open');}else{p.classList.remove('fb-collapsed');p.classList.add('active','open','expanded','is-open','show');if(p.tagName==='DETAILS')p.setAttribute('open','');}header.setAttribute('aria-expanded',willCollapse?'false':'true');var icon=header.querySelector('.faq-icon,.accordion-icon,svg');if(icon){if(willCollapse)icon.classList.remove('fb-icon-rotated');else icon.classList.add('fb-icon-rotated');}}
  function bindFaq(){if(document.body.__faqDelegateBound)return;document.body.__faqDelegateBound=true;document.body.addEventListener('click',function(ev){var t=ev.target;if(!t||!t.closest)return;var actionable=t.closest('a,button,input,select,textarea,label,[role="button"],[onclick]');var header=t.closest('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-question,.accordion-toggle,.accordion-button,[data-faq-toggle],[data-toggle="collapse"],summary');if(!header)return;if(actionable&&header.contains(actionable)&&actionable!==header)return;ev.preventDefault();ev.stopPropagation();try{toggleFaq(header);}catch(e){}},true);document.querySelectorAll('.faq-header,.faq-question,.faq-title,.accordion-header,.accordion-button,summary').forEach(function(h){h.style.cursor='pointer';});}
  function bindThumbs(){if(document.body.__thumbDelegateBound)return;document.body.__thumbDelegateBound=true;document.body.addEventListener('click',function(ev){var t=ev.target;if(!t||!t.closest)return;var tc=t.closest('.thumbImage,.swiper-thumbs,[data-thumb-container]');if(!tc)return;var ti=t.closest('.swiper-slide,[data-thumb],img');if(!ti)return;var sib=Array.prototype.slice.call(tc.querySelectorAll('.swiper-slide,[data-thumb]'));if(!sib.length)sib=Array.prototype.slice.call(tc.querySelectorAll('img'));var idx=sib.indexOf(ti);if(idx<0){var p=ti;while(p&&idx<0){idx=sib.indexOf(p);p=p.parentElement;}}var mainEl=document.querySelector('.swiper.mainImage');if(mainEl&&mainEl.swiper&&idx>=0){try{mainEl.swiper.slideTo(idx);}catch(_){}}var img=ti.tagName==='IMG'?ti:ti.querySelector('img');if(img){var src=img.currentSrc||img.src||img.getAttribute('data-src');if(src){var m=document.querySelector('.swiper.mainImage .swiper-slide-active img,.swiper.mainImage .swiper-slide img,.mainImage img:not(.thumb),.product-image img');if(m){m.src=src;m.removeAttribute('srcset');}}}},true);}
  function initSwipers(){if(typeof window.Swiper!=='function')return false;var thumbs=[];document.querySelectorAll('.swiper.thumbImage,.swiper.swiper-thumbs').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;try{thumbs.push(new window.Swiper(el,{slidesPerView:'auto',spaceBetween:10,watchSlidesProgress:true,freeMode:true,slideToClickedSlide:true}));}catch(_){}});document.querySelectorAll('.swiper.mainImage').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;var opts={slidesPerView:1,spaceBetween:10,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}};if(thumbs[0])opts.thumbs={swiper:thumbs[0]};try{new window.Swiper(el,opts);}catch(_){}});document.querySelectorAll('.swiper').forEach(function(el){if(el.swiper||el.__swBound)return;el.__swBound=true;var ann=el.classList.contains('announcement_bar');try{new window.Swiper(el,{slidesPerView:1,spaceBetween:10,loop:ann,autoplay:ann?{delay:3500}:false,navigation:{nextEl:el.querySelector('.swiper-button-next'),prevEl:el.querySelector('.swiper-button-prev')},pagination:{el:el.querySelector('.swiper-pagination'),clickable:true}});}catch(_){}});document.querySelectorAll('.stickSection').forEach(function(s){s.style.display='';});return true;}
  function bootstrap(){bindFaq();bindThumbs();var hasJq=typeof window.jQuery!=='undefined';var hasSw=typeof window.Swiper==='function';loadCss('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css');var pending=0;function done(){if(--pending<=0)finalize();}if(!hasJq){pending++;loadScript('https://code.jquery.com/jquery-3.5.1.min.js',done);}if(!hasSw){pending++;loadScript('https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',done);}if(pending===0)finalize();}
  function finalize(){initSwipers();bindFaq();bindThumbs();setTimeout(function(){initSwipers();},1500);}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',bootstrap);}else{setTimeout(bootstrap,50);}
})();</script>`;

function finalizeSwipe({ html, sourceUrl, texts, rewrites, productName, applySpaPreviewMode }) {
  const t0 = Date.now();
  if (!html || typeof html !== 'string' || html.length < 50) {
    throw new Error('html is required');
  }
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts[] is required');
  if (!Array.isArray(rewrites)) throw new Error('rewrites[] is required');

  const originalHtml = html;
  const isSpa = detectSpa(originalHtml);

  // id → rewritten map. Quando la pagina e' SPA applichiamo SPA-safety:
  // ogni rewrite che ha aggiunto tag non presenti nell'originale viene
  // strippato a plain text, altrimenti l'hydration di Vue/React/Svelte
  // fa bail e disabilita tutti i click handler (accordion, slider, ecc.).
  const idToRewrite = new Map();
  const textById = new Map();
  let spaSafetyStrips = 0;
  for (const t of texts) textById.set(t.id, t);
  for (const rw of rewrites) {
    if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
    const trimmed = rw.rewritten.trim();
    if (!trimmed) continue;
    const original = textById.get(rw.id);
    const originalText = original?.original;
    if (originalText && trimmed === originalText) continue;
    let safeText = trimmed;
    if (isSpa) {
      const before = safeText;
      safeText = enforceSpaSafety(originalText || '', safeText);
      if (safeText !== before) spaSafetyStrips++;
      if (!safeText) continue;
    }
    idToRewrite.set(rw.id, safeText);
  }
  const unresolvedIds = texts.filter((t) => !idToRewrite.has(t.id)).map((t) => t.id);

  const replacementPairs = [];
  const serverSideTitlePairs = [];
  const serverSideMetaPairs = [];
  for (const [id, rewritten] of idToRewrite) {
    const original = textById.get(id);
    if (!original || !rewritten || original.original === rewritten) continue;
    if (original.tag === 'title') {
      serverSideTitlePairs.push({ from: original.original, to: rewritten });
      replacementPairs.push({ from: original.original, to: rewritten });
    } else if (original.tag === 'attr:meta-content') {
      serverSideMetaPairs.push({ from: original.original, to: rewritten });
    } else if (original.tag.startsWith('attr:')) {
      replacementPairs.push({
        from: original.original,
        to: rewritten,
        attr: original.tag.replace('attr:', ''),
      });
    } else {
      replacementPairs.push({ from: original.original, to: rewritten });
    }
  }

  // swipeScript (SPA-aware con MutationObserver + polling)
  const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${JSON.stringify(replacementPairs)};
  function escRx(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  function normWS(s){return (s||'').replace(/\\s+/g,' ').trim();}
  var prepared = pairs.map(function(p){
    var fn = normWS(p.from);
    return { from: p.from, to: p.to, attr: p.attr, norm: fn,
      rx: fn ? new RegExp(escRx(fn).replace(/ /g,'\\\\s+'),'g') : null };
  }).filter(function(p){return p.norm && p.norm.length>=2;});
  function tryReplace(text){
    if(!text) return text;
    var out = text;
    for(var i=0;i<prepared.length;i++){
      var p = prepared[i];
      if(p.attr) continue;
      if(out.indexOf(p.from)!==-1){ out = out.split(p.from).join(p.to); }
      else if(p.rx && p.rx.test(out)){ p.rx.lastIndex=0; out = out.replace(p.rx, p.to); }
    }
    return out;
  }
  function applyAll(root){
    if(!root) return 0;
    var changed = 0;
    var blockSel = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,button,a,label,figcaption,blockquote,summary,legend,span,strong,em,b,i';
    var elems = root.querySelectorAll ? root.querySelectorAll(blockSel) : [];
    for(var k=0;k<elems.length;k++){
      var el = elems[k];
      if(el.querySelector && el.querySelector(blockSel)) continue;
      var fullNorm = normWS(el.textContent);
      if(!fullNorm) continue;
      for(var p2=0;p2<prepared.length;p2++){
        var pp = prepared[p2];
        if(pp.attr) continue;
        if(fullNorm === pp.norm && el.textContent !== pp.to){
          el.textContent = pp.to; changed++; break;
        }
      }
    }
    function walkText(node){
      if(node.nodeType===3){
        var t = node.textContent; var nt = tryReplace(t);
        if(nt !== t){ node.textContent = nt; changed++; }
      } else if(node.nodeType===1 && node.tagName!=='SCRIPT' && node.tagName!=='STYLE'){
        for(var c=node.firstChild;c;c=c.nextSibling) walkText(c);
      }
    }
    if(root.nodeType) walkText(root);
    for(var a=0;a<prepared.length;a++){
      var pa = prepared[a];
      if(!pa.attr) continue;
      var els = root.querySelectorAll ? root.querySelectorAll('['+pa.attr+']') : [];
      for(var j=0;j<els.length;j++){
        var v = els[j].getAttribute(pa.attr); if(!v) continue;
        var nv = v;
        if(v.indexOf(pa.from)!==-1){ nv = v.split(pa.from).join(pa.to); }
        else if(pa.rx && pa.rx.test(v)){ pa.rx.lastIndex=0; nv = v.replace(pa.rx, pa.to); }
        if(nv !== v){ els[j].setAttribute(pa.attr, nv); changed++; }
      }
    }
    var titleEl = document.querySelector('title');
    if(titleEl){
      var tt = titleEl.textContent; var ntt = tryReplace(tt);
      if(ntt !== tt){ titleEl.textContent = ntt; changed++; }
    }
    return changed;
  }
  applyAll(document);
  if(document.readyState !== 'loading'){ setTimeout(function(){ applyAll(document); }, 0); }
  else { document.addEventListener('DOMContentLoaded', function(){ applyAll(document); }); }
  if(typeof MutationObserver !== 'undefined'){
    var pendingApply = null;
    var observer = new MutationObserver(function(){
      if(pendingApply) return;
      pendingApply = setTimeout(function(){ pendingApply = null; applyAll(document); }, 100);
    });
    if(document.body){
      observer.observe(document.body, { childList:true, subtree:true, characterData:true });
    } else {
      document.addEventListener('DOMContentLoaded', function(){
        if(document.body) observer.observe(document.body, { childList:true, subtree:true, characterData:true });
      });
    }
    setTimeout(function(){ try { observer.disconnect(); } catch(e){} }, 30000);
  }
  var pollCount = 0;
  var pollTimer = setInterval(function(){
    pollCount++; applyAll(document);
    if(pollCount >= 20) clearInterval(pollTimer);
  }, 500);
})();
<\/script>`;

  // Server-side replace title + meta
  let preparedHtml = originalHtml;
  for (const tp of serverSideTitlePairs) {
    const rx = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(escHtml(tp.from))}\\s*(<\\/title>)`, 'gi');
    const before = preparedHtml;
    preparedHtml = preparedHtml.replace(rx, `$1${escHtml(tp.to)}$2`);
    if (preparedHtml === before) {
      const rxRaw = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(tp.from)}\\s*(<\\/title>)`, 'gi');
      preparedHtml = preparedHtml.replace(rxRaw, `$1${escHtml(tp.to)}$2`);
    }
  }
  for (const mp of serverSideMetaPairs) {
    const rxDQ = new RegExp(`(<meta\\b[^>]*\\bcontent=)"${escRxLiteral(escAttr(mp.from))}"`, 'gi');
    const rxSQ = new RegExp(`(<meta\\b[^>]*\\bcontent=)'${escRxLiteral(escAttr(mp.from))}'`, 'gi');
    preparedHtml = preparedHtml.replace(rxDQ, `$1"${escAttr(mp.to)}"`);
    preparedHtml = preparedHtml.replace(rxSQ, `$1'${escAttr(mp.to)}'`);
    const rxRaw = new RegExp(`(<meta\\b[^>]*\\bcontent=)(["'])${escRxLiteral(mp.from)}\\2`, 'gi');
    preparedHtml = preparedHtml.replace(rxRaw, `$1$2${escAttr(mp.to)}$2`);
  }

  // Server-side DOM text replace (per SPA che re-idratano).
  // Strategia a cascata per ogni pair, ordinate per length desc così i testi
  // lunghi vincono sui figli inline e non c'è doppia sostituzione parziale:
  //   1) HTML-encoded literal (testo cosi' com'e' nell'HTML serializzato)
  //   2) raw literal (se differisce dall'encoded)
  //   3) JSON-encoded literal (es. dentro __NEXT_DATA__ / spa-json)
  //   4) FUZZY tag-tolerant + distributeTextProportionally
  //      (per testo spezzato tra <strong>, <em>, <span>, <br>, &nbsp; ecc.)
  const dedupedDomPairs = replacementPairs
    .filter((p) => !p.attr && p.from && p.to && p.from !== p.to)
    .sort((a, b) => b.from.length - a.from.length);
  let serverReplacementsCount = 0;
  let fuzzyReplacementsCount = 0;
  const unmatchedAfterServer = [];
  for (const pair of dedupedDomPairs) {
    if (pair.from.length < 3) continue;
    const fromEsc = escHtml(pair.from);
    const toEsc = escHtml(pair.to);
    let appliedThisPair = false;
    {
      const before = preparedHtml;
      preparedHtml = preparedHtml.split(fromEsc).join(toEsc);
      if (preparedHtml !== before) { serverReplacementsCount++; appliedThisPair = true; }
    }
    if (pair.from !== fromEsc) {
      const beforeRaw = preparedHtml;
      preparedHtml = preparedHtml.split(pair.from).join(pair.to);
      if (preparedHtml !== beforeRaw) { serverReplacementsCount++; appliedThisPair = true; }
    }
    const fromJson = JSON.stringify(pair.from).slice(1, -1);
    const toJson = JSON.stringify(pair.to).slice(1, -1);
    if (fromJson !== pair.from && fromJson !== fromEsc) {
      const beforeJson = preparedHtml;
      preparedHtml = preparedHtml.split(fromJson).join(toJson);
      if (preparedHtml !== beforeJson) { serverReplacementsCount++; appliedThisPair = true; }
    }
    if (!appliedThisPair) unmatchedAfterServer.push(pair);
  }

  // 4° tentativo: fuzzy tag-tolerant per i pair non ancora applicati. Questa
  // pass cattura "Old <strong>head</strong>line" che il literal split sopra
  // non vedrebbe mai. Distribuisce il nuovo testo proporzionalmente sui
  // segmenti preservando ESATTAMENTE tutti i tag inline (cruciale su Vue/
  // React per non rompere l'hydration).
  for (const pair of unmatchedAfterServer) {
    const res1 = fuzzyReplaceWithTagPreservation(preparedHtml, pair.from, pair.to);
    if (res1.replaced) { preparedHtml = res1.html; fuzzyReplacementsCount++; continue; }
    const fromEsc = escHtml(pair.from);
    if (fromEsc !== pair.from) {
      const res2 = fuzzyReplaceWithTagPreservation(preparedHtml, fromEsc, escHtml(pair.to));
      if (res2.replaced) { preparedHtml = res2.html; fuzzyReplacementsCount++; }
    }
  }

  // Attributi
  for (const pair of replacementPairs) {
    if (!pair.attr || !pair.from || !pair.to || pair.from === pair.to) continue;
    const fromAttrEsc = escAttr(pair.from);
    const toAttrEsc = escAttr(pair.to);
    const rxDQ = new RegExp(`(\\b${escRxLiteral(pair.attr)}=)"${escRxLiteral(fromAttrEsc)}"`, 'gi');
    const rxSQ = new RegExp(`(\\b${escRxLiteral(pair.attr)}=)'${escRxLiteral(fromAttrEsc)}'`, 'gi');
    const before = preparedHtml;
    preparedHtml = preparedHtml.replace(rxDQ, `$1"${toAttrEsc}"`);
    preparedHtml = preparedHtml.replace(rxSQ, `$1'${toAttrEsc}'`);
    if (preparedHtml !== before) serverReplacementsCount++;
  }

  // Pulizia finale prima del swipeScript:
  //   - Liquid/Jinja placeholders ({{MMMM dd, yyyy}}, {{Location}}…) → valori reali
  //   - brand replace dal dominio (es. "nooro" → productName) con TLD guard
  //   - collapse consecutive brand runs ("Reset Patch Reset Patch" → "Reset Patch")
  preparedHtml = replaceLiquidPlaceholders(preparedHtml);
  if (productName && typeof productName === 'string' && productName.trim().length >= 3) {
    preparedHtml = replaceBrandInHtml(preparedHtml, sourceUrl, originalHtml, productName.trim());
    preparedHtml = collapseConsecutiveBrandRuns(preparedHtml, productName.trim());
  }

  // SPA preview mode (opt-in, default = auto-on per pagine SPA).
  // Strippa <script>, <noscript>, on* handlers originali e inietta:
  //   - fix navigation Next.js (/_next/data/* → 200 vuoto)
  //   - CSS hard-override FAQ/accordion (sempre visibili)
  //   - fallback init (FAQ delegate, thumb→main image, Swiper da CDN)
  // Cosi' il preview e' interattivo anche quando il bundle originale
  // tenta di montare su un dominio che non e' il suo e fallisce.
  const previewModeRequested =
    applySpaPreviewMode === true || (applySpaPreviewMode !== false && isSpa);
  let scriptStripStats = null;
  if (previewModeRequested) {
    const strip = stripOriginalScripts(preparedHtml);
    scriptStripStats = { before: strip.scriptsBefore, after: strip.scriptsAfter };
    preparedHtml = strip.html;
    // FAQ CSS + navigation fix nel <head>; fallback init prima di </body>.
    const headInjection = FAQ_CSS_OVERRIDE + NEXTJS_NAVIGATION_FIX;
    if (preparedHtml.includes('</head>')) {
      preparedHtml = preparedHtml.replace('</head>', headInjection + '</head>');
    } else if (preparedHtml.includes('<body')) {
      preparedHtml = preparedHtml.replace(/(<body[^>]*>)/, headInjection + '$1');
    } else {
      preparedHtml = headInjection + preparedHtml;
    }
    if (preparedHtml.includes('</body>')) {
      preparedHtml = preparedHtml.replace('</body>', FALLBACK_INIT_SCRIPT + '</body>');
    } else {
      preparedHtml += FALLBACK_INIT_SCRIPT;
    }
  }

  let resultHtml = preparedHtml;
  if (resultHtml.includes('</body>')) {
    resultHtml = resultHtml.replace('</body>', swipeScript + '</body>');
  } else {
    resultHtml += swipeScript;
  }

  const newTitle = serverSideTitlePairs[0]?.to
    || (texts.length > 0 ? replacementPairs.find((p) => !p.attr)?.to || '' : '');
  const totalReplacements = replacementPairs.length + serverSideTitlePairs.length + serverSideMetaPairs.length;

  return {
    success: true,
    html: resultHtml,
    original_title: originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
    new_title: newTitle,
    original_length: originalHtml.length,
    new_length: resultHtml.length,
    totalTexts: texts.length,
    replacements: totalReplacements,
    replacements_dom: replacementPairs.length,
    replacements_title: serverSideTitlePairs.length,
    replacements_meta: serverSideMetaPairs.length,
    replacements_server_side_html: serverReplacementsCount,
    replacements_server_side_fuzzy: fuzzyReplacementsCount,
    is_spa_page: isSpa,
    spa_safety_strips: spaSafetyStrips,
    spa_preview_mode_applied: previewModeRequested,
    spa_preview_script_strip: scriptStripStats,
    unresolved_text_ids: unresolvedIds,
    coverage_ratio: texts.length ? totalReplacements / texts.length : 0,
    provider: 'openclaw-local-inproc',
    method_used: 'universal-extract+dom-replacement-batched (worker in-process)',
    changes_made: replacementPairs.map((p) => ({
      from: p.from.substring(0, 50),
      to: p.to.substring(0, 50),
    })),
    finalize_duration_ms: Date.now() - t0,
    sourceUrl: sourceUrl ?? null,
  };
}

module.exports = { finalizeSwipe };
