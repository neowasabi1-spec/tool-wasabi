import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/landing/swipe/openclaw-finalize
 *
 * "Light second half" of /api/landing/swipe for the worker-driven path.
 * The worker did its rewrite loop against the local OpenClaw LLM and
 * sends us:
 *   • the original HTML (provided by the UI from the clone result, or
 *     fetched locally by the worker)
 *   • the texts array we returned from /openclaw-build-prompts (so we
 *     don't need to re-extract — just look up by id)
 *   • the rewrites map produced by the LLM
 *
 * We:
 *   1. Build replacement pairs (DOM / title / meta) with the same
 *      logic as /api/landing/swipe lines 579-746.
 *   2. Server-side replace the <title> and <meta content="…"> (the
 *      DOM-replacer script can't reach them).
 *   3. Inject the well-tested swipeScript that runs at page load and
 *      replaces visible text + attributes in the user's iframe.
 *   4. Return the SAME shape as the legacy endpoint so the existing
 *      handleSwipe in clone-landing/page.tsx consumes either path
 *      interchangeably.
 *
 * Body:
 *   {
 *     html: string,                 // original page HTML (pre-swipe)
 *     sourceUrl?: string,           // for audit only
 *     texts: [{ id, original, tag }],
 *     rewrites: [{ id, rewritten }],
 *   }
 *
 * Returns the SAME shape as /api/landing/swipe success path.
 */

interface TextEntry {
  id: number;
  original: string;
  tag: string;
}
interface RewriteEntry {
  id: number;
  rewritten: string;
}

function escRxLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: {
    html?: string;
    sourceUrl?: string;
    texts?: TextEntry[];
    rewrites?: RewriteEntry[];
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  if (!body.html || typeof body.html !== 'string' || body.html.length < 50) {
    return NextResponse.json({ error: 'html is required' }, { status: 400 });
  }
  if (!Array.isArray(body.texts) || body.texts.length === 0) {
    return NextResponse.json({ error: 'texts[] is required' }, { status: 400 });
  }
  if (!Array.isArray(body.rewrites)) {
    return NextResponse.json({ error: 'rewrites[] is required' }, { status: 400 });
  }

  const originalHtml = body.html;
  const texts = body.texts;
  const rewritesArr = body.rewrites;

  // id → rewritten map. Drops ids the worker echoed back identical to
  // the original (legitimate for ultra-short / structural strings, but
  // we don't want to inject a no-op replacement script for them).
  const idToRewrite = new Map<number, string>();
  const textById = new Map<number, TextEntry>();
  for (const t of texts) textById.set(t.id, t);

  for (const rw of rewritesArr) {
    if (typeof rw.id !== 'number' || typeof rw.rewritten !== 'string') continue;
    const trimmed = rw.rewritten.trim();
    if (!trimmed) continue;
    const original = textById.get(rw.id)?.original;
    if (original && trimmed === original) continue;
    idToRewrite.set(rw.id, trimmed);
  }

  const unresolvedIds = texts
    .filter((t) => !idToRewrite.has(t.id))
    .map((t) => t.id);

  // Same partitioning as /api/landing/swipe lines 579-604.
  const replacementPairs: Array<{ from: string; to: string; attr?: string }> = [];
  const serverSideTitlePairs: Array<{ from: string; to: string }> = [];
  const serverSideMetaPairs: Array<{ from: string; to: string }> = [];
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

  // ── swipeScript — IDENTICAL to /api/landing/swipe lines 618-706. ──
  // Kept in sync by hand. If you change one, mirror to the other.
  // The escaped `<\/script>` at the bottom prevents the host parser
  // from terminating this <script> block prematurely.
  const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${JSON.stringify(replacementPairs)};
  function escRx(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  function normWS(s){return (s||'').replace(/\\s+/g,' ').trim();}
  var prepared = pairs.map(function(p){
    var fn = normWS(p.from);
    return {
      from: p.from,
      to: p.to,
      attr: p.attr,
      norm: fn,
      rx: fn ? new RegExp(escRx(fn).replace(/ /g,'\\\\s+'),'g') : null
    };
  }).filter(function(p){return p.norm && p.norm.length>=2;});
  function tryReplace(text){
    if(!text) return text;
    var out = text;
    for(var i=0;i<prepared.length;i++){
      var p = prepared[i];
      if(p.attr) continue;
      if(out.indexOf(p.from)!==-1){
        out = out.split(p.from).join(p.to);
      } else if(p.rx && p.rx.test(out)){
        p.rx.lastIndex = 0;
        out = out.replace(p.rx, p.to);
      }
    }
    return out;
  }
  var blockSel = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,button,a,label,figcaption,blockquote,summary,legend,span,strong,em,b,i';
  var elems = document.body ? document.body.querySelectorAll(blockSel) : [];
  for(var k=0;k<elems.length;k++){
    var el = elems[k];
    if(el.querySelector(blockSel)) continue;
    var fullNorm = normWS(el.textContent);
    if(!fullNorm) continue;
    for(var p2=0;p2<prepared.length;p2++){
      var pp = prepared[p2];
      if(pp.attr) continue;
      if(fullNorm === pp.norm){
        el.textContent = pp.to;
        break;
      }
    }
  }
  function walkText(node){
    if(node.nodeType===3){
      var t = node.textContent;
      var nt = tryReplace(t);
      if(nt !== t) node.textContent = nt;
    } else if(node.nodeType===1 && node.tagName!=='SCRIPT' && node.tagName!=='STYLE'){
      for(var c=node.firstChild;c;c=c.nextSibling) walkText(c);
    }
  }
  if(document.body) walkText(document.body);
  for(var a=0;a<prepared.length;a++){
    var pa = prepared[a];
    if(!pa.attr) continue;
    var els = document.querySelectorAll('['+pa.attr+']');
    for(var j=0;j<els.length;j++){
      var v = els[j].getAttribute(pa.attr);
      if(!v) continue;
      var nv = v;
      if(v.indexOf(pa.from)!==-1){
        nv = v.split(pa.from).join(pa.to);
      } else if(pa.rx && pa.rx.test(v)){
        pa.rx.lastIndex = 0;
        nv = v.replace(pa.rx, pa.to);
      }
      if(nv !== v) els[j].setAttribute(pa.attr, nv);
    }
  }
  var titleEl = document.querySelector('title');
  if(titleEl){
    var tt = titleEl.textContent;
    var ntt = tryReplace(tt);
    if(ntt !== tt) titleEl.textContent = ntt;
  }
})();
<\/script>`;

  // Server-side replace: <title> e <meta content="..."> (same as
  // /api/landing/swipe lines 708-739).
  let preparedHtml = originalHtml;
  for (const tp of serverSideTitlePairs) {
    const rx = new RegExp(
      `(<title[^>]*>)\\s*${escRxLiteral(escHtml(tp.from))}\\s*(<\\/title>)`,
      'gi',
    );
    const before = preparedHtml;
    preparedHtml = preparedHtml.replace(rx, `$1${escHtml(tp.to)}$2`);
    if (preparedHtml === before) {
      const rxRaw = new RegExp(
        `(<title[^>]*>)\\s*${escRxLiteral(tp.from)}\\s*(<\\/title>)`,
        'gi',
      );
      preparedHtml = preparedHtml.replace(rxRaw, `$1${escHtml(tp.to)}$2`);
    }
  }
  for (const mp of serverSideMetaPairs) {
    const rxDQ = new RegExp(
      `(<meta\\b[^>]*\\bcontent=)"${escRxLiteral(escAttr(mp.from))}"`,
      'gi',
    );
    const rxSQ = new RegExp(
      `(<meta\\b[^>]*\\bcontent=)'${escRxLiteral(escAttr(mp.from))}'`,
      'gi',
    );
    preparedHtml = preparedHtml.replace(rxDQ, `$1"${escAttr(mp.to)}"`);
    preparedHtml = preparedHtml.replace(rxSQ, `$1'${escAttr(mp.to)}'`);
    const rxRaw = new RegExp(
      `(<meta\\b[^>]*\\bcontent=)(["'])${escRxLiteral(mp.from)}\\2`,
      'gi',
    );
    preparedHtml = preparedHtml.replace(rxRaw, `$1$2${escAttr(mp.to)}$2`);
  }

  let resultHtml = preparedHtml;
  if (resultHtml.includes('</body>')) {
    resultHtml = resultHtml.replace('</body>', swipeScript + '</body>');
  } else {
    resultHtml += swipeScript;
  }

  const newTitle =
    serverSideTitlePairs[0]?.to ||
    (texts.length > 0 ? replacementPairs.find((p) => !p.attr)?.to || '' : '');

  const totalReplacements =
    replacementPairs.length + serverSideTitlePairs.length + serverSideMetaPairs.length;

  return NextResponse.json({
    success: true,
    html: resultHtml,
    original_title:
      originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '',
    new_title: newTitle,
    original_length: originalHtml.length,
    new_length: resultHtml.length,
    totalTexts: texts.length,
    replacements: totalReplacements,
    replacements_dom: replacementPairs.length,
    replacements_title: serverSideTitlePairs.length,
    replacements_meta: serverSideMetaPairs.length,
    unresolved_text_ids: unresolvedIds,
    coverage_ratio: texts.length ? totalReplacements / texts.length : 0,
    provider: 'openclaw-local',
    method_used: 'universal-extract+dom-replacement-batched (worker-driven)',
    changes_made: replacementPairs.map((p) => ({
      from: p.from.substring(0, 50),
      to: p.to.substring(0, 50),
    })),
    finalize_duration_ms: Date.now() - t0,
    sourceUrl: body.sourceUrl ?? null,
  });
}
