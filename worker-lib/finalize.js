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

function finalizeSwipe({ html, sourceUrl, texts, rewrites }) {
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

  // Server-side DOM text replace (per SPA che re-idratano)
  const dedupedDomPairs = replacementPairs
    .filter((p) => !p.attr && p.from && p.to && p.from !== p.to)
    .sort((a, b) => b.from.length - a.from.length);
  let serverReplacementsCount = 0;
  for (const pair of dedupedDomPairs) {
    if (pair.from.length < 3) continue;
    const fromEsc = escHtml(pair.from);
    const toEsc = escHtml(pair.to);
    {
      const before = preparedHtml;
      preparedHtml = preparedHtml.split(fromEsc).join(toEsc);
      if (preparedHtml !== before) serverReplacementsCount++;
    }
    if (pair.from !== fromEsc) {
      const beforeRaw = preparedHtml;
      preparedHtml = preparedHtml.split(pair.from).join(pair.to);
      if (preparedHtml !== beforeRaw) serverReplacementsCount++;
    }
    const fromJson = JSON.stringify(pair.from).slice(1, -1);
    const toJson = JSON.stringify(pair.to).slice(1, -1);
    if (fromJson !== pair.from && fromJson !== fromEsc) {
      const beforeJson = preparedHtml;
      preparedHtml = preparedHtml.split(fromJson).join(toJson);
      if (preparedHtml !== beforeJson) serverReplacementsCount++;
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
