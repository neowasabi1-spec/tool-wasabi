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

function finalizeSwipe({ html, sourceUrl, texts, rewrites, productName }) {
  const t0 = Date.now();
  if (!html || typeof html !== 'string' || html.length < 50) {
    throw new Error('html is required');
  }
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts[] is required');
  if (!Array.isArray(rewrites)) throw new Error('rewrites[] is required');

  const originalHtml = html;

  // id → rewritten map
  const idToRewrite = new Map();
  const textById = new Map();
  for (const t of texts) textById.set(t.id, t);
  for (const rw of rewrites) {
    if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
    const trimmed = rw.rewritten.trim();
    if (!trimmed) continue;
    const original = textById.get(rw.id)?.original;
    if (original && trimmed === original) continue;
    idToRewrite.set(rw.id, trimmed);
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
