import { createClient } from '@supabase/supabase-js';
import { extractAllTextsUniversal } from '../../src/lib/universal-text-extractor';
import {
  extractLandingMediaForProject,
  listLandingMedia,
  matchLandingMediaToSlots,
  sectionFromNearbyHtml,
  type LandingMediaItem,
  type LandingSection,
} from '../../src/lib/landing-media';

/**
 * Background function (up to 15 min) that performs the Chimera Protocol
 * FUNNEL SWIPE: for every Clone/Swipe page created by the pipeline's `swipe`
 * step it
 *   1. loads the competitor step's saved HTML (page_html written by the
 *      extension's funnel walk) or fetches the live URL,
 *   2. rewrites ALL marketing texts for OUR product (Claude, in the market's
 *      local language) using the same universal-extract + DOM-replacer
 *      technique as /api/landing/swipe,
 *   3. INTERNAL restyle (ChatGPT quality): same template skeleton, new visual
 *      world — full theme CSS, every photo recreated (GPT Image 2), packshots
 *      swapped to our product, copy baked into the HTML. Not a hex/script patch.
 *   4. saves the swiped HTML into page_html + updates the funnel_pages row
 *      so the result is visible in the Clone/Swipe section.
 *
 * Decoupled from pipeline-run-background. Image restyle is split into short
 * batches (a few photos each). When a batch finishes the worker re-invokes
 * itself with the leftover work, so a run never rides the 15-minute cap.
 *
 * Body: { projectId, secret, market, mainImageUrl, pages, imageOffset?,
 *         restyle?, imagesLeft?, mediaUsed? }
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.PIPELINE_SWIPE_MODEL || 'claude-opus-4-8';
const IMG_MODEL_T2I = process.env.PIPELINE_IMAGE_MODEL || 'openai/gpt-image-2';
const PROJECT_FILES_BUCKET = 'project-files';

const GLOBAL_BUDGET_MS = 8 * 60_000;
const IMAGE_BATCH = 4;
const MAX_TEXTS = 350;
const BATCH_SIZE = 30;
const BATCH_CONCURRENCY = 3;
const MAX_IMAGES_PER_PAGE = 5;
const MAX_IMAGES_TOTAL = 18;
const MAX_IMAGES_PER_PAGE_RESTYLE = 18;
const MAX_IMAGES_TOTAL_RESTYLE = 36;

function siteBaseUrl(): string {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Supabase env (URL / SERVICE_ROLE_KEY) missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type SupabaseClient = ReturnType<typeof getSupabase>;

interface SwipePage {
  funnelPageId: string;
  sourcePageId: string;
  sourceUrl: string;
  name: string;
  type: string;
  htmlUrl?: string;
}

interface RestyleSpec {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  ink: string;
  avatar: string;
  stylePrefix: string;
  palette: Array<{ from: string; to: string }>;
}

interface SwipeCtx {
  projectId: string;
  productName: string;
  productContext: string;
  market: string;
  mainImageUrl: string | null;
  imageMode: 'affiliate' | 'internal';
  landingStills: LandingMediaItem[];
  landingVideos: LandingMediaItem[];
  mediaUsed: Set<string>;
  restyle: RestyleSpec | null;
  ownerUserId: string | null;
}

// ---------------------------------------------------------------------------
// Anthropic helpers (plain caller + vision caller)
// ---------------------------------------------------------------------------

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not configured');
  return k;
}

async function callClaudeText(system: string, user: string, maxTokens: number, timeoutMs = 150_000): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

async function callClaudeVision(
  system: string,
  userText: string,
  image: { mediaType: string; b64: string } | null,
  maxTokens: number,
): Promise<string> {
  const content: Array<Record<string, unknown>> = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.b64 } });
  }
  content.push({ type: 'text', text: userText });
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

// ---------------------------------------------------------------------------
// fal.ai — GPT Image 2 (same queue API as pipeline-run-background)
// ---------------------------------------------------------------------------

function falKey(): string { return process.env.FAL_KEY || process.env.FAL_AI_API_KEY || ''; }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function falGenerateImageUrl(endpoint: string, input: Record<string, unknown>, timeoutMs = 180_000): Promise<string | null> {
  const key = falKey();
  if (!key) return null;
  try {
    const sub = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    if (!sub.ok) { console.warn('[swipe] fal submit', sub.status, (await sub.text()).slice(0, 200)); return null; }
    const s = await sub.json() as { status_url?: string; response_url?: string };
    if (!s.status_url || !s.response_url) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3_000);
      const st = await fetch(s.status_url, { headers: { Authorization: `Key ${key}` }, cache: 'no-store' });
      if (!st.ok) continue;
      const sj = await st.json() as { status?: string; error?: string };
      if (sj.status === 'COMPLETED') {
        const rr = await fetch(s.response_url, { headers: { Authorization: `Key ${key}` }, cache: 'no-store' });
        if (!rr.ok) return null;
        const result = await rr.json() as { images?: Array<{ url?: string }> };
        return result?.images?.[0]?.url || null;
      }
      if (sj.status === 'ERROR') { console.warn('[swipe] fal job error', sj.error); return null; }
    }
    return null;
  } catch (e) {
    console.warn('[swipe] fal threw:', (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source HTML loading
// ---------------------------------------------------------------------------

async function loadSavedHtml(sb: SupabaseClient, pageId: string, kind: 'cloned' | 'swiped' = 'cloned'): Promise<string> {
  if (!pageId) return '';
  try {
    const { data } = await sb
      .from('page_html')
      .select('html')
      .eq('page_id', pageId)
      .eq('kind', kind)
      .eq('variant', 'desktop')
      .maybeSingle();
    return typeof data?.html === 'string' ? data.html : '';
  } catch {
    return '';
  }
}

async function fetchHtmlUrl(url: string): Promise<string> {
  if (!url) return '';
  const abs = /^https?:\/\//i.test(url) ? url : `${siteBaseUrl()}${url.startsWith('/') ? '' : '/'}${url}`;
  if (!abs) return '';
  try {
    const res = await fetch(abs, { signal: AbortSignal.timeout(25_000), redirect: 'follow' });
    if (!res.ok) return '';
    const html = await res.text();
    return html.length > 500 ? html : '';
  } catch {
    return '';
  }
}

async function fetchViaJina(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'html' };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return '';
    const html = await res.text();
    return html.length > 800 ? html : '';
  } catch {
    return '';
  }
}

async function loadSourceHtml(sb: SupabaseClient, page: SwipePage): Promise<string> {
  let html = '';
  if (page.sourcePageId) {
    html = await loadSavedHtml(sb, page.sourcePageId, 'cloned');
    if (html.length < 800) html = (await loadSavedHtml(sb, page.sourcePageId, 'swiped')) || html;
  }
  if (html.length < 800 && page.htmlUrl) html = (await fetchHtmlUrl(page.htmlUrl)) || html;
  if (html.length < 800 && page.sourceUrl) html = (await fetchLiveHtml(page.sourceUrl)) || html;
  if (html.length < 800 && page.sourceUrl) html = (await fetchViaJina(page.sourceUrl)) || html;
  return html;
}

async function fetchLiveHtml(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return '';
    const html = await res.text();
    return html.length > 500 ? html : '';
  } catch {
    return '';
  }
}

/** Relative assets in a saved snapshot break outside the origin — a <base>
 *  tag fixes images/css/links in one move without touching <script> bodies. */
function ensureBaseHref(html: string, sourceUrl: string): string {
  if (!/^https?:\/\//i.test(sourceUrl)) return html;
  if (/<base\b/i.test(html)) return html;
  let baseHref = '';
  try { baseHref = new URL('.', sourceUrl).href; } catch { return html; }
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (!headMatch || headMatch.index === undefined) return html;
  const at = headMatch.index + headMatch[0].length;
  return `${html.slice(0, at)}<base href="${baseHref}">${html.slice(at)}`;
}

// ---------------------------------------------------------------------------
// TEXT SWIPE — universal extract + batched Claude rewrite + DOM-replacer
// (same technique as /api/landing/swipe, adapted to run inside this worker)
// ---------------------------------------------------------------------------

const SAFE_META_NAMES = new Set([
  'description', 'keywords', 'author',
  'og:title', 'og:description', 'og:site_name',
  'twitter:title', 'twitter:description',
]);

const SAFE_TEXT_PREFIXES = [
  'tag:h1', 'tag:h2', 'tag:h3', 'tag:h4', 'tag:h5', 'tag:h6',
  'tag:p', 'tag:li', 'tag:td', 'tag:th', 'tag:dt', 'tag:dd',
  'tag:button', 'tag:a', 'tag:label', 'tag:figcaption',
  'tag:blockquote', 'tag:summary', 'tag:legend', 'tag:option',
  'tag:span', 'tag:strong', 'tag:em', 'tag:b', 'tag:i', 'tag:u',
  'tag:small', 'tag:mark', 'tag:cite', 'tag:q',
  'mixed:p', 'mixed:div', 'mixed:li', 'mixed:td', 'mixed:th',
  'mixed:h1', 'mixed:h2', 'mixed:h3', 'mixed:h4', 'mixed:h5', 'mixed:h6',
  'mixed:span', 'mixed:strong', 'mixed:em', 'mixed:a', 'mixed:b', 'mixed:i',
];
const SAFE_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'value']);

interface SwipeText { original: string; kind: 'title' | 'meta' | 'attr' | 'text'; attr?: string; prio: number; }

function classifyContext(ctx: string): { kind: SwipeText['kind']; attr?: string; prio: number } | null {
  if (ctx === 'title') return { kind: 'title', prio: 0 };
  if (ctx.startsWith('meta:')) {
    return SAFE_META_NAMES.has(ctx.slice(5).toLowerCase()) ? { kind: 'meta', prio: 5 } : null;
  }
  if (ctx.startsWith('attr:')) {
    const a = ctx.slice(5).split(':')[0].toLowerCase();
    return SAFE_ATTRS.has(a) ? { kind: 'attr', attr: a, prio: 5 } : null;
  }
  for (const p of SAFE_TEXT_PREFIXES) {
    if (ctx === p || ctx.startsWith(p + ':')) {
      const tag = p.split(':')[1];
      const prio = /^h[12]$|^button$/.test(tag) ? 1 : /^h[3-6]$|^p$|^li$/.test(tag) ? 2 : /^a$|^label$/.test(tag) ? 3 : 6;
      return { kind: 'text', prio };
    }
  }
  return null;
}

function collectSwipeTexts(html: string): SwipeText[] {
  const universal = extractAllTextsUniversal(html);
  const seen = new Map<string, SwipeText>();
  const out: SwipeText[] = [];
  for (const u of universal) {
    const cls = classifyContext(u.context);
    if (!cls) continue;
    const t = u.text;
    if (t.length < 2 || t.length > 4000) continue;
    if (!/[a-zA-ZÀ-ÿ]/.test(t)) continue;
    if (t.startsWith('http://') || t.startsWith('https://')) continue;
    if (t.includes('{') && t.includes('}') && /[=:]\s*function|=>/.test(t)) continue;
    const existing = seen.get(t);
    if (existing) {
      if (cls.prio < existing.prio) { existing.kind = cls.kind; existing.attr = cls.attr; existing.prio = cls.prio; }
      continue;
    }
    const entry: SwipeText = { original: t, kind: cls.kind, attr: cls.attr, prio: cls.prio };
    seen.set(t, entry);
    out.push(entry);
  }
  if (out.length > MAX_TEXTS) {
    out.sort((a, b) => a.prio - b.prio);
    return out.slice(0, MAX_TEXTS);
  }
  return out;
}

function cleanJsonArray(text: string): string {
  let c = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const s = c.indexOf('[');
  const e = c.lastIndexOf(']');
  if (s >= 0 && e > s) c = c.substring(s, e + 1);
  return c.trim();
}

async function rewriteAllTexts(
  systemPrompt: string,
  texts: SwipeText[],
  deadline: number,
): Promise<Map<number, string>> {
  const items = texts.map((t, i) => ({ id: i, text: t.original }));
  const result = new Map<number, string>();
  const byId = new Map(items.map((t) => [t.id, t.text]));

  const runBatch = async (batch: Array<{ id: number; text: string }>, label: string) => {
    const user = `${label}: return exactly one JSON object per input id (${batch.length} items). Never skip an id.

Rewrite these texts so they sell ONLY the described product. Keep the same conversational energy (headlines stay headlines, CTAs stay CTAs). Plain text only in "rewritten" — no HTML or markdown.

Input:
${JSON.stringify(batch, null, 2)}

Output shape: [{"id": number, "rewritten": "..."}, ...] — include EVERY id (any order ok).`;
    const raw = await callClaudeText(systemPrompt, user, 8000, 120_000);
    const parsed = JSON.parse(cleanJsonArray(raw)) as Array<{ id: number; rewritten: string }>;
    if (!Array.isArray(parsed)) throw new Error('batch: expected JSON array');
    for (const rw of parsed) {
      if (typeof rw.id !== 'number' || rw.rewritten == null) continue;
      const trimmed = String(rw.rewritten).trim();
      if (!trimmed || trimmed === byId.get(rw.id)) continue;
      result.set(rw.id, trimmed);
    }
  };

  const runPool = async (pool: Array<Array<{ id: number; text: string }>>, labelOf: (i: number) => string) => {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        if (Date.now() > deadline) return;
        const idx = cursor++;
        if (idx >= pool.length) return;
        try { await runBatch(pool[idx], labelOf(idx)); }
        catch (e) { console.warn('[swipe] batch failed:', (e as Error).message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, pool.length) }, worker));
  };

  const batches: Array<Array<{ id: number; text: string }>> = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
  await runPool(batches, (i) => `Batch ${i + 1} of ${batches.length}`);

  // One gap-fill sweep for ids missed by failed batches.
  const missing = items.filter((t) => !result.has(t.id));
  if (missing.length && Date.now() < deadline) {
    const gaps: Array<Array<{ id: number; text: string }>> = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) gaps.push(missing.slice(i, i + BATCH_SIZE));
    await runPool(gaps, () => 'GAP-FILL — every id mandatory');
  }
  return result;
}

function escRxLiteral(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Apply rewrites: server-side <title>/<meta>, plus the injected DOM-replacer
 *  script (whitespace-tolerant) for body texts + attributes — the exact
 *  technique /api/landing/swipe uses, so results render identically. */
function bakePairsIntoHtml(
  html: string,
  pairs: Array<{ from: string; to: string; attr?: string }>,
): string {
  const sorted = pairs
    .filter((p) => !p.attr && p.from && p.to && p.from !== p.to && p.from.length >= 2)
    .sort((a, b) => b.from.length - a.from.length);
  if (!sorted.length) return html;
  const parts = html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/gi);
  return parts.map((part) => {
    if (/^<(script|style)\b/i.test(part)) return part;
    let out = part;
    for (const p of sorted) {
      if (out.includes(p.from)) out = out.split(p.from).join(p.to);
      const escFrom = escHtml(p.from);
      if (escFrom !== p.from && out.includes(escFrom)) out = out.split(escFrom).join(escHtml(p.to));
    }
    return out;
  }).join('');
}

function applyRewrites(
  originalHtml: string,
  texts: SwipeText[],
  rewrites: Map<number, string>,
): { html: string; replacements: number; newTitle: string; changes: Array<{ from: string; to: string }> } {
  const replacementPairs: Array<{ from: string; to: string; attr?: string }> = [];
  const titlePairs: Array<{ from: string; to: string }> = [];
  const metaPairs: Array<{ from: string; to: string }> = [];

  for (const [id, rewritten] of rewrites) {
    const t = texts[id];
    if (!t || !rewritten || t.original === rewritten) continue;
    if (t.kind === 'title') {
      titlePairs.push({ from: t.original, to: rewritten });
      replacementPairs.push({ from: t.original, to: rewritten });
    } else if (t.kind === 'meta') {
      metaPairs.push({ from: t.original, to: rewritten });
    } else if (t.kind === 'attr') {
      replacementPairs.push({ from: t.original, to: rewritten, attr: t.attr });
    } else {
      replacementPairs.push({ from: t.original, to: rewritten });
    }
  }

  // JSON-in-<script> safe encode (see /api/landing/swipe for the rationale).
  const pairsJson = JSON.stringify(replacementPairs)
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const swipeScript = `<script data-swipe-replacer>
(function(){
  var pairs = ${pairsJson};
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
      else if(p.rx && p.rx.test(out)){ p.rx.lastIndex = 0; out = out.replace(p.rx, p.to); }
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
      if(fullNorm === pp.norm){ el.textContent = pp.to; break; }
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
      if(v.indexOf(pa.from)!==-1){ nv = v.split(pa.from).join(pa.to); }
      else if(pa.rx && pa.rx.test(v)){ pa.rx.lastIndex = 0; nv = v.replace(pa.rx, pa.to); }
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

  let html = originalHtml;
  // Server-side <title> replace (browser tab + SEO/social preview).
  for (const tp of titlePairs) {
    const rx = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(escHtml(tp.from))}\\s*(<\\/title>)`, 'gi');
    const before = html;
    html = html.replace(rx, `$1${escHtml(tp.to)}$2`);
    if (html === before) {
      const rxRaw = new RegExp(`(<title[^>]*>)\\s*${escRxLiteral(tp.from)}\\s*(<\\/title>)`, 'gi');
      html = html.replace(rxRaw, `$1${escHtml(tp.to)}$2`);
    }
  }
  // Server-side <meta content> replace, whitelist-guarded.
  const isSafeMetaTag = (metaTagStr: string): boolean => {
    const m = metaTagStr.match(/\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i);
    return !!m && SAFE_META_NAMES.has(m[1].toLowerCase());
  };
  for (const mp of metaPairs) {
    const replaceMetaContent = (htmlStr: string, fromValue: string, toValue: string) => {
      const tagRe = new RegExp(`<meta\\b([^>]*?)\\bcontent\\s*=\\s*(["'])${escRxLiteral(fromValue)}\\2([^>]*)>`, 'gi');
      return htmlStr.replace(tagRe, (full, attrsBefore, q, attrsAfter) => {
        if (!isSafeMetaTag(full)) return full;
        return `<meta${attrsBefore}content=${q}${escAttr(toValue)}${q}${attrsAfter}>`;
      });
    };
    html = replaceMetaContent(html, escAttr(mp.from), mp.to);
    if (mp.from !== escAttr(mp.from)) html = replaceMetaContent(html, mp.from, mp.to);
  }

  // Bake copy into the HTML so preview works without JavaScript (the
  // watch popup sandboxes scripts; a script-only swipe looks unchanged).
  html = bakePairsIntoHtml(html, replacementPairs);

  // Idempotency: strip any previous swipe-replacer before injecting ours.
  html = html.replace(/<script\b[^>]*\bdata-swipe-replacer\b[^>]*>[\s\S]*?<\/script>/gi, '');
  if (html.includes('</body>')) {
    html = html.replace('</body>', () => swipeScript + '</body>');
  } else {
    html += swipeScript;
  }

  const newTitle = titlePairs[0]?.to || replacementPairs.find((p) => !p.attr)?.to || '';
  const replacements = replacementPairs.length + titlePairs.length + metaPairs.length;
  const changes = replacementPairs.slice(0, 40).map((p) => ({ from: p.from.slice(0, 50), to: p.to.slice(0, 50) }));
  return { html, replacements, newTitle, changes };
}

// ---------------------------------------------------------------------------
// IMAGE SWIPE — understand each image (Claude vision) → GPT Image 2 prompt →
// generate → replace; competitor product shots use the product mockup instead.
// ---------------------------------------------------------------------------

const IMG_JUNK_RE = /logo|icon|favicon|sprite|pixel|badge|payment|visa|mastercard|amex|paypal|klarna|apple-?pay|g-?pay|arrow|chevron|star|rating|trustpilot|flag|emoji|loader|spinner|spacer|blank\.|placeholder\./i;

interface PageImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  position: number;
  context: string;
  section: LandingSection;
}

function collectImages(html: string, sourceUrl: string, restyle = false): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();
  const tagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const srcset = tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bdata-lazy-src\s*=\s*["']([^"']+)["']/i)?.[1]
      || (srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '';
    if (!src || src.startsWith('data:')) continue;
    if (/\.svg(\?|#|$)/i.test(src)) continue;
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    const junk = restyle
      ? /favicon|sprite|pixel|1x1|tracking|doubleclick|visa|mastercard|amex|paypal|klarna|apple-?pay|loader|spinner|spacer/i
      : IMG_JUNK_RE;
    if (junk.test(src) || junk.test(alt)) continue;
    const width = Number.parseInt(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const height = Number.parseInt(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || '0', 10);
    const minPx = restyle ? 40 : 80;
    if ((width && width < minPx) || (height && height < minPx)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    // Nearby text gives the vision model the section's message.
    const from = Math.max(0, m.index - 700);
    const to = Math.min(html.length, m.index + tag.length + 700);
    const context = html.slice(from, to)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    const section = sectionFromNearbyHtml(html, m.index, tag);
    out.push({ src, alt, width, height, position: m.index, context, section });
    if (out.length >= 40) break;
  }
  const bgRe = /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bgRe.exec(html)) !== null && out.length < 40) {
    const src = bm[2];
    if (!src || src.startsWith('data:') || /\.svg(\?|#|$)/i.test(src) || seen.has(src)) continue;
    if (IMG_JUNK_RE.test(src)) continue;
    seen.add(src);
    out.push({
      src,
      alt: '',
      width: 0,
      height: 0,
      position: bm.index,
      context: '',
      section: sectionFromNearbyHtml(html, bm.index, bm[0]),
    });
  }
  // Earlier on the page = more important (hero first).
  out.sort((a, b) => a.position - b.position);
  void sourceUrl;
  return out.slice(0, restyle ? MAX_IMAGES_PER_PAGE_RESTYLE : MAX_IMAGES_PER_PAGE);
}

function absolutizeSrc(src: string, sourceUrl: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (!sourceUrl) return '';
  try { return new URL(src, sourceUrl).href; } catch { return ''; }
}

const VISION_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function downloadForVision(url: string): Promise<{ mediaType: string; b64: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!VISION_MEDIA_TYPES.has(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2_000 || buf.length > 4_500_000) return null;
    return { mediaType: ct, b64: buf.toString('base64') };
  } catch {
    return null;
  }
}

interface ImageAnalysis { productShot: boolean; format: string; prompt: string; }

function parseImageAnalysis(raw: string): ImageAnalysis | null {
  try {
    let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const s = c.indexOf('{');
    const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) c = c.slice(s, e + 1);
    const obj = JSON.parse(c) as Record<string, unknown>;
    const prompt = String(obj.prompt || '').trim();
    if (!prompt) return null;
    return {
      productShot: obj.product_shot === true || obj.productShot === true,
      format: String(obj.format || 'image').slice(0, 80),
      prompt: prompt.slice(0, 1200),
    };
  } catch {
    return null;
  }
}

function falImageSize(img: PageImage): string {
  if (img.width && img.height) {
    const ratio = img.width / img.height;
    if (ratio >= 1.4) return 'landscape_4_3';
    if (ratio <= 0.72) return 'portrait_4_3';
  }
  return 'square_hd';
}

let _bucketEnsured = false;
async function ensureBucket(sb: SupabaseClient): Promise<void> {
  if (_bucketEnsured) return;
  try {
    const { error } = await sb.storage.createBucket(PROJECT_FILES_BUCKET, { public: true, fileSizeLimit: 52428800 });
    if (error && !/already exists|duplicate/i.test(error.message)) console.warn('[swipe] ensureBucket:', error.message);
  } catch (e) { console.warn('[swipe] ensureBucket threw:', (e as Error).message); }
  _bucketEnsured = true;
}

async function storeGeneratedImage(sb: SupabaseClient, projectId: string, falUrl: string, idx: number): Promise<string | null> {
  try {
    const res = await fetch(falUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const ct = res.headers.get('content-type') || 'image/png';
    const ext = /jpeg|jpg/.test(ct) ? 'jpg' : /webp/.test(ct) ? 'webp' : 'png';
    await ensureBucket(sb);
    const key = `${projectId}/swipe_image/${Date.now()}_${idx}.${ext}`;
    const { error } = await sb.storage.from(PROJECT_FILES_BUCKET).upload(key, buf, { contentType: ct, upsert: false });
    if (error) { console.warn('[swipe] image upload failed:', error.message); return null; }
    const { data: pub } = sb.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(key);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}

/** Replace every occurrence of the original src (raw + HTML-escaped) so both
 *  src= and srcset= entries pick up the new image. */
function replaceImageSrc(html: string, oldSrc: string, newUrl: string): string {
  let out = html.split(oldSrc).join(newUrl);
  const escaped = oldSrc.replace(/&/g, '&amp;');
  if (escaped !== oldSrc) out = out.split(escaped).join(newUrl);
  return out;
}

function normHex(raw: string): string {
  let h = raw.replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : '';
}

function topPageHex(html: string, limit = 14): string[] {
  const counts = new Map<string, number>();
  const re = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const hex = normHex(m[0]);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => h)
    .slice(0, limit);
}

function hexToRgbCsv(hex: string): string {
  const h = normHex(hex);
  if (!h) return '';
  const n = Number.parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function remapOldColors(html: string, spec: RestyleSpec): string {
  let out = html;
  const pairs = spec.palette.filter((p) => normHex(p.from) && normHex(p.to) && normHex(p.from) !== normHex(p.to));
  for (const { from, to } of pairs) {
    const a = normHex(from);
    const b = normHex(to);
    out = out.split(a).join(b);
    out = out.split(a.toUpperCase()).join(b);
    const rgbA = hexToRgbCsv(a);
    const rgbB = hexToRgbCsv(b);
    if (rgbA && rgbB) {
      out = out.split(`rgb(${rgbA})`).join(`rgb(${rgbB})`);
      out = out.split(`rgba(${rgbA},`).join(`rgba(${rgbB},`);
    }
    if (a[1] === a[2] && a[3] === a[4] && a[5] === a[6]) {
      const short = `#${a[1]}${a[3]}${a[5]}`;
      out = out.split(short).join(b);
      out = out.split(short.toUpperCase()).join(b);
    }
  }
  return out;
}

/** Full visual theme on the existing template — not a hex patch. */
function applyTheme(html: string, spec: RestyleSpec): string {
  let out = remapOldColors(html, spec);
  const css = `<style data-chimera-theme>
:root,html{
  --chimera-primary:${spec.primary};--chimera-secondary:${spec.secondary};--chimera-accent:${spec.accent};
  --chimera-bg:${spec.background};--chimera-ink:${spec.ink};
  --primary:${spec.primary};--color-primary:${spec.primary};--brand:${spec.primary};--brand-color:${spec.primary};
  --bs-primary:${spec.primary};--theme-color:${spec.primary};--main-color:${spec.primary};
  --secondary:${spec.secondary};--color-secondary:${spec.secondary};--accent:${spec.accent};
  --background:${spec.background};--bg:${spec.background};--surface:${spec.background};
  --text:${spec.ink};--ink:${spec.ink};--foreground:${spec.ink};
}
html,body{background:${spec.background} !important;color:${spec.ink} !important;}
h1,h2,h3,h4,h5,h6{color:${spec.primary} !important;}
p,li,td,th,label,span,div{color:inherit;}
a{color:${spec.accent} !important;}
button,input[type=submit],input[type=button],.btn,[class*="btn"],[class*="Btn"],[class*="cta"],[class*="CTA"],[class*="button"]{
  background:${spec.primary} !important;border-color:${spec.primary} !important;color:#fff !important;
}
header,nav,[class*="header"],[class*="Header"],[class*="navbar"],[class*="nav-"]{
  background:${spec.secondary} !important;color:#fff !important;
}
[class*="hero"],[class*="Hero"],[class*="banner"],[class*="Banner"],[class*="jumbo"]{
  background:${spec.secondary} !important;color:#fff !important;
}
[class*="hero"] h1,[class*="Hero"] h1,[class*="banner"] h1,[class*="hero"] p,[class*="Hero"] p{color:#fff !important;}
section,[class*="section"],[class*="block"],[class*="wrapper"]{background-color:transparent;}
footer,[class*="footer"],[class*="Footer"]{background:${spec.secondary} !important;color:#fff !important;}
[class*="card"],[class*="Card"],[class*="tile"],[class*="panel"]{
  background:#fff !important;border-color:${spec.accent} !important;
}
input,select,textarea{border-color:${spec.primary} !important;accent-color:${spec.primary} !important;}
::selection{background:${spec.accent};color:${spec.ink};}
</style>`;
  out = out.replace(/<style\b[^>]*\bdata-chimera-(?:theme|palette)\b[^>]*>[\s\S]*?<\/style>/gi, '');
  if (out.includes('</head>')) out = out.replace('</head>', `${css}</head>`);
  else out = css + out;
  return out;
}

function fallbackRestyleSpec(ctx: SwipeCtx, oldHex: string[]): RestyleSpec {
  const news = ['#c45c12', '#7a1f1a', '#e8b84a', '#2d4a3e', '#8b3a1a'];
  const palette = oldHex
    .filter((h) => h !== '#ffffff' && h !== '#000000' && h !== '#fff' && h !== '#000')
    .slice(0, 12)
    .map((from, i) => ({ from, to: news[i % news.length] }));
  return {
    primary: '#c45c12',
    secondary: '#7a1f1a',
    accent: '#e8b84a',
    background: '#fff8f2',
    ink: '#1a120c',
    avatar: `One consistent on-brand customer for ${ctx.productName}, same face and age in every lifestyle photo`,
    stylePrefix: `Premium commercial photography for ${ctx.productName}: warm saffron and burgundy world, shallow depth of field, consistent lighting and casting`,
    palette,
  };
}

function parseRestyleSpec(raw: string): RestyleSpec | null {
  try {
    let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const s = c.indexOf('{');
    const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) c = c.slice(s, e + 1);
    const obj = JSON.parse(c) as Record<string, unknown>;
    const palette = Array.isArray(obj.palette)
      ? (obj.palette as Array<Record<string, unknown>>)
          .map((p) => ({ from: normHex(String(p.from || '')), to: normHex(String(p.to || '')) }))
          .filter((p) => p.from && p.to)
      : [];
    const stylePrefix = String(obj.stylePrefix || obj.style_prefix || '').trim();
    if (!stylePrefix) return null;
    return {
      primary: normHex(String(obj.primary || '')) || '#c45c12',
      secondary: normHex(String(obj.secondary || '')) || '#7a1f1a',
      accent: normHex(String(obj.accent || '')) || '#e8b84a',
      background: normHex(String(obj.background || '')) || '#fff8f2',
      ink: normHex(String(obj.ink || '')) || '#1a120c',
      avatar: String(obj.avatar || 'same demographic as the original, updated for our product').slice(0, 280),
      stylePrefix: stylePrefix.slice(0, 700),
      palette,
    };
  } catch {
    return null;
  }
}

async function buildRestyleSpec(html: string, ctx: SwipeCtx): Promise<RestyleSpec | null> {
  const colors = topPageHex(html);
  const system = `You are an art director restyling a competitor landing into OUR product — same layout, new visual world (ChatGPT swipe quality).
Return STRICT JSON only:
{
  "primary":"#rrggbb",
  "secondary":"#rrggbb",
  "accent":"#rrggbb",
  "background":"#rrggbb",
  "ink":"#rrggbb",
  "avatar":"one consistent person/casting description used in EVERY lifestyle photo",
  "stylePrefix":"20-40 words: photography style + color world + product look, prepended to every image prompt",
  "palette":[{"from":"#old","to":"#new"}, ...]
}
Map EVERY supplied old hex that is a brand/section color (not #fff/#000 unless they are accent fills). New palette must match OUR product (flavor, category, mood). If a product photo is attached, take primary/secondary/accent FROM that photo. No competitor brand names.`;
  const user = `OUR PRODUCT: ${ctx.productName}
${ctx.productContext ? `CONTEXT:\n${ctx.productContext.slice(0, 2500)}` : ''}
${ctx.mainImageUrl ? 'A photo of OUR real product is attached — extract its actual colors and use them as the new palette.' : 'No product photo — invent a coherent palette for this product.'}
OLD PAGE HEX COLORS (most used first): ${colors.join(', ') || '(none found)'}
Design a full restyle so the competitor page becomes our product the way a designer would: new palette, same grid.`;
  try {
    const visual = ctx.mainImageUrl ? await downloadForVision(ctx.mainImageUrl) : null;
    const raw = visual
      ? await callClaudeVision(system, user, visual, 1200)
      : await callClaudeText(system, user, 1200, 60_000);
    return parseRestyleSpec(raw) || fallbackRestyleSpec(ctx, colors);
  } catch (e) {
    console.warn('[swipe] restyle spec failed:', (e as Error).message);
    return fallbackRestyleSpec(ctx, colors);
  }
}

function collectVideos(html: string): Array<{ src: string; section: LandingSection }> {
  const out: Array<{ src: string; section: LandingSection }> = [];
  const seen = new Set<string>();
  const re = /<video\b[^>]*>[\s\S]*?<\/video>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, section: sectionFromNearbyHtml(html, m.index, m[0], { kind: 'video' }) });
  }
  const srcRe = /<(?:source|video)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = srcRe.exec(html)) !== null) {
    const src = m[1];
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    if (!/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src) && !/<video/i.test(m[0])) continue;
    seen.add(src);
    out.push({ src, section: sectionFromNearbyHtml(html, m.index, m[0], { kind: 'video' }) });
  }
  return out.slice(0, 6);
}

function applyAffiliateMedia(
  html: string,
  stills: LandingMediaItem[],
  videos: LandingMediaItem[],
  used: Set<string>,
): { html: string; placed: number; videos: number } {
  let out = html;
  let placed = 0;
  let vids = 0;
  const images = collectImages(out, '');
  for (const { slot, item } of matchLandingMediaToSlots(images, stills, used)) {
    if (!item) continue;
    out = replaceImageSrc(out, slot.src, item.storedUrl);
    placed++;
  }
  const vtags = collectVideos(out);
  for (const { slot, item } of matchLandingMediaToSlots(vtags, videos, used)) {
    if (!item) continue;
    out = replaceImageSrc(out, slot.src, item.storedUrl);
    vids++;
  }
  return { html: out, placed, videos: vids };
}

async function swipeImages(
  sb: SupabaseClient,
  html: string,
  ctx: SwipeCtx,
  page: SwipePage,
  budget: { imagesLeft: number },
  deadline: number,
  sourceStills: LandingMediaItem[],
  opts: { startOffset?: number; maxThisBatch?: number } = {},
): Promise<{ html: string; generated: number; productSwaps: number; analyzed: number; processed: number; remaining: number; total: number }> {
  let out = html;
  let generated = 0;
  let productSwaps = 0;
  let analyzed = 0;
  let processed = 0;

  const restyle = ctx.imageMode === 'internal';
  const images = collectImages(html, page.sourceUrl, restyle);
  const start = Math.max(0, opts.startOffset || 0);
  const cap = opts.maxThisBatch && opts.maxThisBatch > 0 ? opts.maxThisBatch : images.length;
  const slice = images.slice(start, start + cap);
  if (!images.length || !slice.length) {
    return { html: out, generated, productSwaps, analyzed, processed: 0, remaining: Math.max(0, images.length - start), total: images.length };
  }
  const sourceBySrc = new Map(
    matchLandingMediaToSlots(images, sourceStills, ctx.mediaUsed).map((p) => [p.slot.src, p.item]),
  );

  const spec = ctx.restyle;
  const system = `You are a senior direct-response creative director. You "swipe" a competitor's landing-page image: detect the FORMAT of the original (before/after split-frame, product hero/packshot, lifestyle photo, ingredient close-up, mechanism diagram, infographic/chart, testimonial portrait, press clipping, UGC selfie, comparison table) and write ONE text-to-image prompt that recreates THE SAME FORMAT for OUR product — same tone, framing and layout. Never default to a before/after unless the original truly is one. No competitor brand names in the prompt.

OUR PRODUCT: ${ctx.productName}
${ctx.productContext ? `PRODUCT CONTEXT:\n${ctx.productContext.slice(0, 3000)}` : ''}
${ctx.market ? `TARGET MARKET: ${ctx.market} — any text visible inside the generated image MUST be in this market's local language.` : ''}
${spec ? `VISUAL WORLD (must match every image): ${spec.stylePrefix}\nCASTING (same person in every lifestyle shot): ${spec.avatar}\nPALETTE: ${spec.primary} / ${spec.secondary} / ${spec.accent}` : ''}

Return STRICT JSON only, no prose:
{"product_shot": true|false, "format": "...", "prompt": "..."}
Set "product_shot": true ONLY when the image is essentially a packshot/hero of the competitor's own product (bottle, jar, box, device) — we will substitute OUR real product photo there instead of generating.`;

  for (const img of slice) {
    if (budget.imagesLeft <= 0) break;
    if (Date.now() > deadline - 45_000) break;
    processed++;
    const source = sourceBySrc.get(img.src);
    const absSrc = source?.storedUrl || absolutizeSrc(img.src, page.sourceUrl);

    let analysis: ImageAnalysis | null = null;
    try {
      const visual = absSrc ? await downloadForVision(absSrc) : null;
      const user = `Analyze this landing-page image and produce the swipe JSON.
${visual ? '' : '(The image file was not downloadable — infer the format from the metadata below.)'}
ALT text: ${img.alt || '(none)'}
Surrounding page copy: ${img.context || '(none)'}`;
      const raw = await callClaudeVision(system, user, visual, 800);
      analysis = parseImageAnalysis(raw);
      analyzed++;
    } catch (e) {
      console.warn('[swipe] image analysis failed:', (e as Error).message);
    }
    if (!analysis) {
      analysis = {
        productShot: /product|pack|bottle|jar|box|mockup/i.test(`${img.alt} ${img.context}`),
        format: 'lifestyle',
        prompt: `Recreate this landing-page visual for ${ctx.productName}. Alt: ${img.alt || 'none'}. Scene: ${img.context.slice(0, 220) || 'product hero'}.`,
      };
    }

    await touchPage(sb, page.funnelPageId, `Photo ${start + processed}/${images.length} — generating…`);
    if (analysis.productShot && ctx.mainImageUrl) {
      out = replaceImageSrc(out, img.src, ctx.mainImageUrl);
      productSwaps++;
      budget.imagesLeft--;
      await persistHtml(sb, page.funnelPageId, 'swiped', out, ctx.ownerUserId);
      await touchPage(sb, page.funnelPageId, `Photo ${start + processed}/${images.length} — product shot replaced`);
      continue;
    }

    const prompt = spec
      ? `${spec.stylePrefix}. Same consistent look across the landing. Casting: ${spec.avatar}. Product: ${ctx.productName}. ${analysis.prompt}`
      : analysis.prompt;
    const falInput = {
      prompt: prompt.slice(0, 1800),
      image_size: falImageSize(img),
      quality: restyle ? 'high' : 'medium',
      num_images: 1,
      output_format: 'png',
    };
    let falUrl = await falGenerateImageUrl(IMG_MODEL_T2I, falInput);
    if (!falUrl) falUrl = await falGenerateImageUrl(IMG_MODEL_T2I, falInput);
    if (!falUrl) throw new Error(`GPT Image failed on photo ${start + processed}/${images.length}`);
    const stored = await storeGeneratedImage(sb, ctx.projectId, falUrl, generated);
    const finalUrl = stored || falUrl;
    out = replaceImageSrc(out, img.src, finalUrl);
    generated++;
    budget.imagesLeft--;
    await persistHtml(sb, page.funnelPageId, 'swiped', out, ctx.ownerUserId);
    await touchPage(sb, page.funnelPageId, `Photo ${start + processed}/${images.length} replaced`);
  }

  return {
    html: out,
    generated,
    productSwaps,
    analyzed,
    processed,
    remaining: Math.max(0, images.length - start - processed),
    total: images.length,
  };
}

// ---------------------------------------------------------------------------
// Per-page processing + persistence
// ---------------------------------------------------------------------------

function funnelHtmlUrl(pageId: string, kind: 'cloned' | 'swiped'): string {
  return `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=${kind}&variant=desktop&v=${Date.now()}`;
}

interface PageBatchResult {
  summary: string;
  done: boolean;
  nextOffset: number;
}

async function touchPage(sb: SupabaseClient, pageId: string, swipeResult: string): Promise<void> {
  await sb.from('funnel_pages').update({
    swipe_status: 'in_progress',
    swipe_result: swipeResult.slice(0, 400),
    updated_at: new Date().toISOString(),
  }).eq('id', pageId).then(() => undefined, () => undefined);
}

async function persistHtml(
  sb: SupabaseClient,
  pageId: string,
  kind: 'cloned' | 'swiped',
  html: string,
  ownerUserId: string | null,
): Promise<void> {
  const row: Record<string, unknown> = {
    page_id: pageId,
    kind,
    variant: 'desktop',
    html,
    updated_at: new Date().toISOString(),
  };
  if (ownerUserId) row.owner_user_id = ownerUserId;
  const { error } = await sb.from('page_html').upsert(row, { onConflict: 'page_id,kind,variant' });
  if (error) throw new Error(`saving ${kind} HTML failed: ${error.message}`);
}

async function processPage(
  sb: SupabaseClient,
  ctx: SwipeCtx,
  page: SwipePage,
  budget: { imagesLeft: number },
  deadline: number,
  imageOffset: number,
): Promise<PageBatchResult> {
  const started = Date.now();
  const resume = imageOffset > 0;

  let html = '';
  let originalHtml = '';
  let originalTitle = '';
  let replacements = 0;
  let textsCount = 0;
  let newTitle = '';
  let changes: Array<{ from: string; to: string }> = [];

  await touchPage(sb, page.funnelPageId, resume
    ? `Worker running — photo batch from ${imageOffset + 1}…`
    : 'Worker running — loading page HTML…');

  if (resume) {
    html = await loadSavedHtml(sb, page.funnelPageId, 'swiped');
    originalHtml = await loadSavedHtml(sb, page.funnelPageId, 'cloned');
    if (!html) throw new Error('resume failed: swiped HTML missing');
    originalTitle = originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || page.name;
  } else {
    html = await loadSourceHtml(sb, page);
    if (!html) throw new Error('no source HTML (saved snapshot missing and live fetch failed)');
    html = ensureBaseHref(html, page.sourceUrl);
    originalHtml = html;
    originalTitle = originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';

    const texts = collectSwipeTexts(originalHtml);
    textsCount = texts.length;
    await touchPage(sb, page.funnelPageId, textsCount
      ? `Rewriting ${textsCount} texts…`
      : 'No texts found — restyling photos…');
    if (texts.length) {
      const system = `You are a world-class direct-response copywriter. You rewrite competitor-style marketing texts to sell ONLY one specific product, without changing HTML structure downstream.

PRODUCT NAME: ${ctx.productName}

FULL PRODUCT CONTEXT (source of truth for facts, angles, benefits, proofs, objections; never invent medical/legal claims):
${ctx.productContext || `(minimal data — derive from the product name: ${ctx.productName})`}

OUTPUT LANGUAGE FOR ALL REWRITES: ${ctx.market ? `the local language of this target market: ${ctx.market} (e.g. German for Germany, Italian for Italy)` : 'the same language as the original text'}

CRITICAL RULES:
1. Treat each input line as discrete visible copy — rewrite it completely for OUR product whenever it is substantive marketing text.
2. Keep the same conversational energy (headline stays headline, CTA stays CTA). Length is free.
3. Plain text ONLY in rewritten strings — no HTML, no markdown.
4. Legal/compliance texts: rewrite only where safe; keep mandatory disclosures.
5. Every batch MUST return one {"id","rewritten"} object per supplied id.`;
      const textDeadline = Math.min(deadline, Date.now() + 180_000);
      const rewrites = await rewriteAllTexts(system, texts, textDeadline);
      const applied = applyRewrites(originalHtml, texts, rewrites);
      html = applied.html;
      replacements = applied.replacements;
      newTitle = applied.newTitle;
      changes = applied.changes;
    }

    if (ctx.imageMode === 'internal') {
      await touchPage(sb, page.funnelPageId, `${replacements}/${textsCount} texts rewritten — building new visual world…`);
      if (!ctx.restyle) ctx.restyle = await buildRestyleSpec(originalHtml, ctx);
      if (!ctx.restyle) ctx.restyle = fallbackRestyleSpec(ctx, topPageHex(originalHtml));
      html = applyTheme(html, ctx.restyle);
    }

    await persistHtml(sb, page.funnelPageId, 'cloned', originalHtml, ctx.ownerUserId);
    await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);
    await touchPage(sb, page.funnelPageId,
      `${replacements}/${textsCount} texts rewritten${ctx.restyle ? ', palette restyled' : ''} — regenerating photos…`);
  }

  let imgRes = { html, generated: 0, productSwaps: 0, analyzed: 0, placed: 0, videos: 0, remaining: 0, total: 0, processed: 0 };
  try {
    if (ctx.imageMode === 'affiliate') {
      if (ctx.landingStills.length || ctx.landingVideos.length) {
        const applied = applyAffiliateMedia(html, ctx.landingStills, ctx.landingVideos, ctx.mediaUsed);
        html = applied.html;
        imgRes = { html, generated: 0, productSwaps: 0, analyzed: 0, placed: applied.placed, videos: applied.videos, remaining: 0, total: 0, processed: 0 };
      }
    } else {
      const batch = await swipeImages(sb, html, ctx, page, budget, deadline, ctx.landingStills, {
        startOffset: imageOffset,
        maxThisBatch: IMAGE_BATCH,
      });
      html = batch.html;
      imgRes = { ...batch, placed: 0, videos: 0 };
    }
  } catch (e) {
    console.warn('[swipe] image swipe failed:', (e as Error).message);
    throw e;
  }

  await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);

  let done = ctx.imageMode === 'affiliate' || imgRes.remaining <= 0 || budget.imagesLeft <= 0;
  if (ctx.imageMode === 'internal' && !resume && !ctx.restyle) {
    throw new Error('Internal restyle has no visual theme. Retry.');
  }
  if (
    ctx.imageMode === 'internal'
    && done
    && imgRes.total > 0
    && imgRes.generated === 0
    && imgRes.productSwaps === 0
    && !resume
  ) {
    throw new Error(`Found ${imgRes.total} photos but regenerated 0. This is not a restyle — retry.`);
  }
  const nextOffset = imageOffset + (imgRes.processed || 0);
  const now = new Date().toISOString();
  const summary =
    (resume ? `photo batch ${imageOffset + 1}–${nextOffset}` : `${replacements}/${textsCount} texts rewritten`) +
    `${imgRes.placed ? `, ${imgRes.placed} landing images placed (affiliate)` : ''}` +
    `${imgRes.videos ? `, ${imgRes.videos} landing videos placed` : ''}` +
    `${!resume && ctx.restyle ? ', new visual theme' : ''}` +
    `${imgRes.generated ? `, ${imgRes.generated} images regenerated` : ''}` +
    `${imgRes.productSwaps ? `, ${imgRes.productSwaps} product shots replaced` : ''}` +
    `${!done && imgRes.total ? ` (${nextOffset}/${imgRes.total} photos)` : ''}`;

  const { error: updErr } = await sb.from('funnel_pages').update({
    swipe_status: done ? 'completed' : 'in_progress',
    swipe_result: done ? summary : `${summary} — next batch queued`,
    cloned_data: {
      htmlUrl: funnelHtmlUrl(page.funnelPageId, 'cloned'),
      title: originalTitle || page.name,
      source_url: page.sourceUrl,
      htmlSkipped: true,
      htmlLength: originalHtml.length || html.length,
      clonedAt: now,
    },
    swiped_data: {
      htmlUrl: funnelHtmlUrl(page.funnelPageId, 'swiped'),
      originalTitle,
      newTitle: newTitle || originalTitle,
      originalLength: originalHtml.length || html.length,
      newLength: html.length,
      processingTime: Date.now() - started,
      methodUsed: 'chimera-protocol-auto-swipe',
      changesMade: changes,
      swipedAt: now,
      htmlSkipped: true,
      htmlLength: html.length,
      imageOffset: nextOffset,
    },
  }).eq('id', page.funnelPageId);
  if (updErr) throw new Error(`funnel_pages update failed: ${updErr.message}`);

  return { summary, done, nextOffset };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  const startedAt = Date.now();
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body */ }

  const secret = String(body.secret || '');
  const expected = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  if (expected && secret !== expected) return new Response('Unauthorized', { status: 401 });

  const projectId = String(body.projectId || '');
  const market = String(body.market || '');
  const mainImageUrl = typeof body.mainImageUrl === 'string' && body.mainImageUrl ? body.mainImageUrl : null;
  const imageMode = body.imageMode === 'affiliate' ? 'affiliate' : 'internal';
  const pages = (Array.isArray(body.pages) ? body.pages : []) as SwipePage[];
  const imageOffset = Math.max(0, Number(body.imageOffset) || 0);
  const incomingRestyle = body.restyle && typeof body.restyle === 'object' ? (body.restyle as RestyleSpec) : null;
  const incomingUsed = Array.isArray(body.mediaUsed) ? (body.mediaUsed as unknown[]).map(String) : [];
  if (!projectId || !pages.length) return new Response('missing projectId/pages', { status: 200 });

  const log = (...a: unknown[]) => console.log(`[swipe ${projectId}]`, ...a);
  const sb = getSupabase();
  await Promise.all(pages.map((p) =>
    touchPage(sb, p.funnelPageId, imageOffset > 0
      ? `Worker picked up — photos from ${imageOffset + 1}…`
      : 'Worker picked up — restyle running…')));

  // Product context: name + description + brief + research from the project.
  const { data: project } = await sb
    .from('projects')
    .select('name, description, brief, market_research, owner_user_id')
    .eq('id', projectId)
    .single();
  const sectionText = (val: unknown): string => {
    if (val == null) return '';
    if (typeof val === 'string') {
      const t = val.trim();
      if (t.startsWith('{')) {
        try {
          const p = JSON.parse(t) as Record<string, unknown>;
          if (typeof p.content === 'string') return p.content;
        } catch { /* plain string */ }
      }
      return val;
    }
    if (typeof val === 'object' && typeof (val as Record<string, unknown>).content === 'string') {
      return (val as Record<string, unknown>).content as string;
    }
    return '';
  };
  const productName = String(project?.name || 'Our product');
  const brief = sectionText(project?.brief);
  const research = sectionText(project?.market_research);
  const parts: string[] = [];
  if (project?.description) parts.push(`DESCRIPTION:\n${String(project.description).slice(0, 2000)}`);
  if (brief) parts.push(`MARKETING BRIEF:\n${brief.slice(0, 6000)}`);
  if (research) parts.push(`MARKET RESEARCH (extract):\n${research.slice(0, 3000)}`);
  let landingItems = await listLandingMedia(sb, projectId);
  if (!landingItems.length) {
    try {
      await extractLandingMediaForProject(sb, projectId);
      landingItems = await listLandingMedia(sb, projectId);
    } catch (e) {
      log('landing media extract:', (e as Error).message);
    }
  }
  const landingStills = landingItems.filter((m) => m.kind === 'image' || m.kind === 'gif');
  const landingVideos = landingItems.filter((m) => m.kind === 'video');

  const ctx: SwipeCtx = {
    projectId,
    productName,
    productContext: parts.join('\n\n'),
    market,
    mainImageUrl,
    imageMode,
    landingStills,
    landingVideos,
    mediaUsed: new Set<string>(incomingUsed),
    restyle: incomingRestyle && incomingRestyle.stylePrefix ? incomingRestyle : null,
    ownerUserId: typeof project?.owner_user_id === 'string' ? project.owner_user_id : null,
  };

  log(`batch ${pages.length} page(s) offset=${imageOffset} market="${market || 'auto'}" mode=${imageMode} landingMedia=${landingItems.length} photo=${mainImageUrl ? 'yes' : 'no'}`);

  const deadline = startedAt + GLOBAL_BUDGET_MS;
  const defaultBudget = imageMode === 'internal' ? MAX_IMAGES_TOTAL_RESTYLE : MAX_IMAGES_TOTAL;
  const budget = { imagesLeft: Number.isFinite(Number(body.imagesLeft)) ? Number(body.imagesLeft) : defaultBudget };

  const page = pages[0];
  let nextPages = pages;
  let nextOffset = imageOffset;

  const runOne = async (p: SwipePage, offset: number): Promise<PageBatchResult> => {
    const result = await processPage(sb, ctx, p, budget, deadline, offset);
    log(`✔ ${p.name}: ${result.summary}`);
    return result;
  };

  try {
    if (imageMode === 'affiliate') {
      for (const p of pages) {
        try { await runOne(p, 0); }
        catch (e) {
          const msg = (e as Error).message?.slice(0, 400) || 'swipe error';
          log(`✘ ${p.name}: ${msg}`);
          await sb.from('funnel_pages').update({ swipe_status: 'failed', swipe_result: msg })
            .eq('id', p.funnelPageId)
            .then(() => undefined, () => undefined);
        }
      }
      nextPages = [];
      nextOffset = 0;
    } else {
      const result = await runOne(page, imageOffset);
      if (result.done) {
        nextPages = pages.slice(1);
        nextOffset = 0;
      } else {
        nextOffset = result.nextOffset;
      }
    }
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 400) || 'swipe error';
    log(`✘ ${page.name}: ${msg}`);
    await sb.from('funnel_pages').update({ swipe_status: 'failed', swipe_result: msg })
      .eq('id', page.funnelPageId)
      .then(() => undefined, () => undefined);
    nextPages = pages.slice(1);
    nextOffset = 0;
  }

  if (nextPages.length && Date.now() < deadline) {
    const base = siteBaseUrl();
    const secretOut = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
    if (base) {
      try {
        await fetch(`${base}/.netlify/functions/pipeline-swipe-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            secret: secretOut,
            market,
            mainImageUrl,
            imageMode,
            pages: nextPages,
            imageOffset: nextOffset,
            restyle: ctx.restyle,
            imagesLeft: budget.imagesLeft,
            mediaUsed: [...ctx.mediaUsed],
          }),
          signal: AbortSignal.timeout(8_000),
        });
        log(`chained next batch: ${nextPages.length} page(s) offset=${nextOffset}`);
      } catch (e) {
        log('chain trigger:', (e as Error).message);
      }
    } else {
      log('cannot chain — site URL missing');
    }
  }

  log(`batch done in ${Math.round((Date.now() - startedAt) / 1000)}s, left=${nextPages.length}`);
  return new Response(JSON.stringify({
    ok: true,
    remaining: nextPages.length,
    imageOffset: nextOffset,
  }), { status: 200 });
};
