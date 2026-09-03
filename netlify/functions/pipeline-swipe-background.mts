import { createClient } from '@supabase/supabase-js';
import { extractAllTextsUniversal } from '../../src/lib/universal-text-extractor';
import {
  extractLandingMediaForProject,
  listLandingMedia,
  pickOfferLandingMedia,
  matchLandingMediaToSlots,
  sectionFromNearbyHtml,
  type LandingMediaItem,
  type LandingSection,
  downloadedLandingMedia,
} from '../../src/lib/landing-media';
import { extractSectionContent } from '../../src/lib/project-sections';
import {
  applyPaintedMedia,
  collectRestyleSlots,
  injectRestyleMediaScript,
  replaceMediaUrl,
  type PaintedMedia,
} from '../../src/lib/restyle-slots';

/**
 * Background function (up to 15 min) that performs the Chimera Protocol
 * FUNNEL SWIPE: for every Clone/Swipe page created by the pipeline's `swipe`
 * step it
 *   1. loads the competitor step's saved HTML (page_html written by the
 *      extension's funnel walk) or fetches the live URL,
 *   2. rewrites ALL marketing texts by CALLING /api/landing/swipe
 *      (the Clone/Swipe engine — extract + Claude + data-swipe-replacer).
 *      Chimera does not invent its own copy path. If the API is unreachable
 *      it falls back to the same applyRewrites script that landing/swipe uses.
 *   3. INTERNAL restyle (ChatGPT quality): same template skeleton, new visual
 *      world — inlined template CSS remapped, theme tokens, every photo edited
 *      via GPT Image 2 image-to-image (keeps composition), packshots swapped
 *      to our product, copy baked into the HTML.
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
const IMG_MODEL_I2I = `${IMG_MODEL_T2I}/edit`;
const PROJECT_FILES_BUCKET = 'project-files';

const GLOBAL_BUDGET_MS = 8 * 60_000;
const IMAGE_BATCH = 4;
const MAX_TEXTS = 350;
const BATCH_SIZE = 30;
const BATCH_CONCURRENCY = 3;
const MAX_IMAGES_PER_PAGE = 5;
const MAX_IMAGES_TOTAL = 18;
const MAX_IMAGES_PER_PAGE_RESTYLE = 40;
const MAX_IMAGES_TOTAL_RESTYLE = 80;

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

/** Same per-field cap Clone/Swipe uses when enqueueing rewrite context. */
const DOC_CAP = 80_000;

interface SwipeCtx {
  projectId: string;
  productName: string;
  productContext: string;
  description: string;
  brief: string;
  research: string;
  market: string;
  mainImageUrl: string | null;
  imageMode: 'affiliate' | 'internal';
  landingStills: LandingMediaItem[];
  landingVideos: LandingMediaItem[];
  mediaUsed: Set<string>;
  restyle: RestyleSpec | null;
  ownerUserId: string | null;
  skipTexts: boolean;
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

async function falGenerateImageUrl(
  endpoint: string,
  input: Record<string, unknown>,
  timeoutMs = 180_000,
  onTick?: () => Promise<void>,
): Promise<string | null> {
  const key = falKey();
  if (!key) {
    console.warn('[swipe] fal: FAL_KEY missing');
    return null;
  }
  try {
    const sub = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    if (!sub.ok) {
      console.warn('[swipe] fal submit', endpoint, sub.status, (await sub.text()).slice(0, 300));
      return null;
    }
    const s = await sub.json() as {
      request_id?: string;
      status_url?: string;
      response_url?: string;
    };
    const statusUrl = s.status_url
      || (s.request_id ? `https://queue.fal.run/${endpoint}/requests/${s.request_id}/status` : '');
    const responseUrl = s.response_url
      || (s.request_id ? `https://queue.fal.run/${endpoint}/requests/${s.request_id}` : '');
    if (!statusUrl || !responseUrl) {
      console.warn('[swipe] fal submit missing urls', endpoint, JSON.stringify(s).slice(0, 200));
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(3_000);
      if (onTick) await onTick().catch(() => undefined);
      const st = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` }, cache: 'no-store' });
      if (!st.ok) continue;
      const sj = await st.json() as { status?: string; error?: string };
      if (sj.status === 'COMPLETED') {
        const rr = await fetch(responseUrl, { headers: { Authorization: `Key ${key}` }, cache: 'no-store' });
        if (!rr.ok) return null;
        const result = await rr.json() as { images?: Array<{ url?: string }> };
        return result?.images?.[0]?.url || null;
      }
      if (sj.status === 'ERROR') { console.warn('[swipe] fal job error', endpoint, sj.error); return null; }
    }
    console.warn('[swipe] fal timed out', endpoint);
    return null;
  } catch (e) {
    console.warn('[swipe] fal threw:', endpoint, (e as Error).message);
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

function rewriteCssUrls(css: string, cssUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, q: string, raw: string) => {
    const u = String(raw || '').trim();
    if (!u || u.startsWith('data:') || /^https?:\/\//i.test(u) || u.startsWith('//')) return all;
    const abs = absolutizeSrc(u, cssUrl);
    return abs ? `url(${q}${abs}${q})` : all;
  });
}

/** Pull the template's real CSS into the HTML so the new palette remaps the
 *  actual brand colors (linked Tailwind/compiled sheets are invisible to hex
 *  replace until they live in the document). */
async function inlineExternalStyles(html: string, sourceUrl: string): Promise<string> {
  const linkRe = /<link\b[^>]*>/gi;
  const links: Array<{ full: string; href: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    if (!/rel\s*=\s*["'][^"']*stylesheet/i.test(m[0])) continue;
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || href.startsWith('data:')) continue;
    if (/fonts\.google|fonts\.gstatic|font-awesome|typekit|use\.typekit|cloudflareinsights/i.test(href)) continue;
    links.push({ full: m[0], href });
  }
  let out = html;
  let inlined = 0;
  const MAX_INLINE = 400_000;
  for (const l of links.slice(0, 8)) {
    if (inlined >= MAX_INLINE) break;
    const abs = absolutizeSrc(l.href, sourceUrl);
    if (!abs) continue;
    try {
      const res = await fetch(abs, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WasabiRestyle/1.0)' },
      });
      if (!res.ok) continue;
      let css = await res.text();
      if (!css || css.length < 20) continue;
      const room = MAX_INLINE - inlined;
      if (css.length > room) css = css.slice(0, room);
      css = rewriteCssUrls(css, abs);
      out = out.split(l.full).join(`<style data-chimera-inlined="${escAttr(abs)}">\n${css}\n</style>`);
      inlined += css.length;
    } catch {
      /* keep the original link */
    }
  }
  return out;
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

/** Ask Clone/Swipe (`/api/landing/swipe`) to rewrite copy. That is the
 *  engine that already worked — Chimera only orchestrates it, then adds
 *  palette + photos on the HTML it returns (incl. data-swipe-replacer). */
function guessSwipeLanguage(html: string, market: string): string {
  if (market) {
    const m = market.toLowerCase();
    if (/german|deutsch|\bde\b|germany/.test(m)) return 'de';
    if (/french|fran[cç]ais|\bfr\b|france/.test(m)) return 'fr';
    if (/spanish|espa[nñ]ol|\bes\b|spain/.test(m)) return 'es';
    if (/italian|itali|\bit\b/.test(m)) return 'it';
    if (/english|\ben\b|uk|usa|united/.test(m)) return 'en';
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').slice(0, 12_000);
  const it = (text.match(/\b(che|non|della|perché|sono|anche|più|questo|questa)\b/gi) || []).length;
  const en = (text.match(/\b(the|and|with|your|this|that|from|have)\b/gi) || []).length;
  return it > en + 3 ? 'it' : 'en';
}

async function runCloneSwipeApi(
  html: string,
  ctx: SwipeCtx,
): Promise<{ html: string; replacements: number; totalTexts: number; newTitle: string } | null> {
  const base = siteBaseUrl();
  if (!base || html.length > 1_800_000) return null;
  try {
    const res = await fetch(`${base}/api/landing/swipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        product: {
          name: ctx.productName,
          description: ctx.description,
          marketing_brief: ctx.brief,
          market_research: ctx.research,
          project_brief: ctx.brief,
          geo_market: ctx.market || undefined,
        },
        tone: 'professional',
        language: guessSwipeLanguage(html, ctx.market),
      }),
      signal: AbortSignal.timeout(280_000),
    });
    if (!res.ok) {
      console.warn('[swipe] /api/landing/swipe HTTP', res.status, await res.text().then((t) => t.slice(0, 200)).catch(() => ''));
      return null;
    }
    const data = await res.json() as {
      success?: boolean;
      html?: string;
      replacements?: number;
      totalTexts?: number;
      new_title?: string;
    };
    if (!data.success || !data.html) return null;
    return {
      html: data.html,
      replacements: data.replacements || 0,
      totalTexts: data.totalTexts || 0,
      newTitle: data.new_title || '',
    };
  } catch (e) {
    console.warn('[swipe] /api/landing/swipe failed:', (e as Error).message);
    return null;
  }
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
  onProgress?: (rewrites: Map<number, string>) => Promise<void>,
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
        try {
          await runBatch(pool[idx], labelOf(idx));
          if (onProgress && result.size) await onProgress(result);
        }
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
function bakeOnePair(haystack: string, from: string, to: string): string {
  let out = haystack;
  if (out.includes(from)) out = out.split(from).join(to);
  const escFrom = escHtml(from);
  if (escFrom !== from && out.includes(escFrom)) out = out.split(escFrom).join(escHtml(to));
  if (from.length >= 8) {
    try {
      const rx = new RegExp(escRxLiteral(from).replace(/ +/g, '\\s+'), 'g');
      if (rx.test(out)) {
        rx.lastIndex = 0;
        out = out.replace(rx, () => to);
      }
    } catch { /* skip */ }
  }
  return out;
}

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
    if (/^<style\b/i.test(part)) return part;
    if (/^<script\b/i.test(part)) {
      if (/data-swipe-replacer/i.test(part)) return part;
      let out = part;
      for (const p of sorted) {
        if (p.from.length < 12) continue;
        out = bakeOnePair(out, p.from, p.to);
        const jsonFrom = JSON.stringify(p.from).slice(1, -1);
        const jsonTo = JSON.stringify(p.to).slice(1, -1);
        if (jsonFrom !== p.from && out.includes(jsonFrom)) out = out.split(jsonFrom).join(jsonTo);
      }
      return out;
    }
    let out = part;
    for (const p of sorted) out = bakeOnePair(out, p.from, p.to);
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
  function run(){
    try{ applyAll(); }catch(e){}
  }
  function applyAll(){
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
  }
  run();
  document.addEventListener('DOMContentLoaded', run);
  window.addEventListener('load', run);
  setTimeout(run, 200);
  setTimeout(run, 800);
  setTimeout(run, 2000);
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

  const beforeBake = html;
  html = bakePairsIntoHtml(html, replacementPairs);
  let bakedHits = 0;
  for (const p of replacementPairs) {
    if (p.attr) continue;
    if (beforeBake.includes(p.from) || beforeBake.includes(escHtml(p.from))) bakedHits++;
    else if (p.to && html.includes(p.to) && !beforeBake.includes(p.to)) bakedHits++;
  }

  // Idempotency: strip any previous swipe-replacer before injecting ours.
  html = html.replace(/<script\b[^>]*\bdata-swipe-replacer\b[^>]*>[\s\S]*?<\/script>/gi, '');
  if (html.includes('</body>')) {
    html = html.replace('</body>', () => swipeScript + '</body>');
  } else {
    html += swipeScript;
  }

  const newTitle = titlePairs[0]?.to || replacementPairs.find((p) => !p.attr)?.to || '';
  // Same counter as /api/landing/swipe: pairs handed to the DOM-replacer,
  // not "how many exact-string bakes hit raw HTML" (that under-counts and
  // made the UI say "rewritten" while preview looked unchanged if the
  // script was stripped).
  const replacements = replacementPairs.length + titlePairs.length + metaPairs.length;
  void bakedHits;
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
  const posterRe = /<video\b[^>]*\bposter\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = posterRe.exec(html)) !== null && out.length < 40) {
    const src = m[1];
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    seen.add(src);
    out.push({
      src,
      alt: 'video poster',
      width: 0,
      height: 0,
      position: m.index,
      context: 'video poster',
      section: sectionFromNearbyHtml(html, m.index, m[0]),
    });
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

function sniffImageType(buf: Buffer, declared: string): string {
  if (VISION_MEDIA_TYPES.has(declared)) return declared;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  return '';
}

async function downloadImageBuf(url: string): Promise<{ mediaType: string; buf: Buffer } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' },
    });
    if (!res.ok) return null;
    const declared = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000 || buf.length > 8_000_000) return null;
    const mediaType = sniffImageType(buf, declared);
    if (!mediaType) return null;
    return { mediaType, buf };
  } catch {
    return null;
  }
}

async function downloadForVision(url: string): Promise<{ mediaType: string; b64: string } | null> {
  const got = await downloadImageBuf(url);
  if (!got) return null;
  if (got.buf.length > 4_500_000) return null;
  return { mediaType: got.mediaType, b64: got.buf.toString('base64') };
}

/** Re-host a competitor photo on our public bucket so fal can fetch it.
 *  Their CDNs usually block fal's crawler — that's why I2I was dying on photo 1. */
async function hostImageForFal(
  sb: SupabaseClient,
  projectId: string,
  url: string,
  idx: number,
): Promise<string | null> {
  const got = await downloadImageBuf(url);
  if (!got) return null;
  try {
    await ensureBucket(sb);
    const ext = /jpeg|jpg/.test(got.mediaType) ? 'jpg' : /webp/.test(got.mediaType) ? 'webp' : 'png';
    const key = `${projectId}/swipe_src/${Date.now()}_${idx}.${ext}`;
    const { error } = await sb.storage.from(PROJECT_FILES_BUCKET).upload(key, got.buf, {
      contentType: got.mediaType,
      upsert: false,
    });
    if (error) {
      console.warn('[swipe] host src failed:', error.message);
      return got.buf.length <= 1_400_000
        ? `data:${got.mediaType};base64,${got.buf.toString('base64')}`
        : null;
    }
    const { data: pub } = sb.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(key);
    return pub?.publicUrl || null;
  } catch (e) {
    console.warn('[swipe] host src threw:', (e as Error).message);
    return got.buf.length <= 1_400_000
      ? `data:${got.mediaType};base64,${got.buf.toString('base64')}`
      : null;
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

function rewriteRootTokens(html: string, spec: RestyleSpec): string {
  return html.replace(/:root\s*\{[\s\S]*?\}/gi, (block) => {
    let out = block;
    const swap = (names: string, color: string) => {
      out = out.replace(
        new RegExp(`(--(?:${names})\\s*:\\s*)([^;}{]+)`, 'gi'),
        `$1${color}`,
      );
    };
    swap('primary|color-primary|brand|brand-color|bs-primary|theme-color|main-color|accent-color', spec.primary);
    swap('secondary|color-secondary|header-bg|nav-bg', spec.secondary);
    swap('accent|highlight|cta', spec.accent);
    swap('background|bg|surface|page-bg|body-bg', spec.background);
    swap('text|ink|foreground|body-color|color-text', spec.ink);
    return out;
  });
}

/** Same template skeleton, new brand tokens — remaps the inlined CSS then
 *  overrides framework utilities (Tailwind/Bootstrap class names) that never
 *  contain a hex to replace. */
function applyTheme(html: string, spec: RestyleSpec): string {
  const held: string[] = [];
  let out = html.replace(/<script\b[^>]*\bdata-swipe-replacer\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    held.push(m);
    return `<!--CHIMERA_SWIPE_SCRIPT_${held.length - 1}-->`;
  });
  out = remapOldColors(out, spec);
  out = rewriteRootTokens(out, spec);
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
a{color:${spec.accent};}
button,input[type=submit],input[type=button],.btn,[class*="btn-primary"],[class*="cta"],[class*="CTA"]{
  background:${spec.primary} !important;border-color:${spec.primary} !important;color:#fff !important;
}
header,nav,[class*="navbar"]{background:${spec.secondary} !important;}
[class*="hero"],[class*="Hero"],[class*="banner"],[class*="Banner"]{background:${spec.secondary} !important;}
footer,[class*="footer"],[class*="Footer"]{background:${spec.secondary} !important;color:#fff !important;}
input,select,textarea{border-color:${spec.primary} !important;accent-color:${spec.primary} !important;}
::selection{background:${spec.accent};color:#fff;}
</style>`;
  out = out.replace(/<style\b[^>]*\bdata-chimera-(?:theme|palette)\b[^>]*>[\s\S]*?<\/style>/gi, '');
  if (out.includes('</head>')) out = out.replace('</head>', `${css}</head>`);
  else out = css + out;
  held.forEach((s, i) => { out = out.replace(`<!--CHIMERA_SWIPE_SCRIPT_${i}-->`, () => s); });
  return out;
}

function productWorldGuess(ctx: SwipeCtx): {
  primary: string; secondary: string; accent: string; background: string; ink: string; world: string;
} {
  const blob = `${ctx.productName} ${ctx.productContext}`.toLowerCase();
  if (/nad|nmn|purple|viola|violet|resveratrol/.test(blob)) {
    return {
      primary: '#6b21a8', secondary: '#3b0764', accent: '#c084fc',
      background: '#faf5ff', ink: '#1e1033',
      world: 'deep violet and amethyst clinical luxury, cool studio light',
    };
  }
  if (/collagen|collagene|berry|mirtillo|cherry|pomegranate|melograno/.test(blob)) {
    return {
      primary: '#b42318', secondary: '#7a1b14', accent: '#f97066',
      background: '#fff7f6', ink: '#1f100e',
      world: 'rich crimson and berry, warm editorial light',
    };
  }
  if (/saffron|zafferano|turmeric|curcuma|gold|oro/.test(blob)) {
    return {
      primary: '#c45c12', secondary: '#7a1f1a', accent: '#e8b84a',
      background: '#fff8f2', ink: '#1a120c',
      world: 'warm saffron and burgundy, golden hour commercial light',
    };
  }
  if (/matcha|chlorophyll|spirulina|green tea|tè verde/.test(blob)) {
    return {
      primary: '#2f6b3a', secondary: '#1a3d24', accent: '#8fbf6a',
      background: '#f4faf4', ink: '#122016',
      world: 'fresh botanical greens, daylight kitchen',
    };
  }
  if (/marine|omega|blue|blu|iodine/.test(blob)) {
    return {
      primary: '#1d4ed8', secondary: '#1e3a5f', accent: '#38bdf8',
      background: '#f0f7ff', ink: '#0b1c2c',
      world: 'oceanic navy and ice blue, clean clinical daylight',
    };
  }
  return {
    primary: '#c45c12', secondary: '#3f2a1d', accent: '#d4a017',
    background: '#faf7f2', ink: '#1a1410',
    world: `premium commercial photography matching ${ctx.productName}`,
  };
}

function fallbackRestyleSpec(ctx: SwipeCtx, oldHex: string[]): RestyleSpec {
  const g = productWorldGuess(ctx);
  const news = [g.primary, g.secondary, g.accent, g.ink, g.primary];
  const palette = oldHex
    .filter((h) => h !== '#ffffff' && h !== '#000000' && h !== '#fff' && h !== '#000')
    .slice(0, 12)
    .map((from, i) => ({ from, to: news[i % news.length] }));
  return {
    primary: g.primary,
    secondary: g.secondary,
    accent: g.accent,
    background: g.background,
    ink: g.ink,
    avatar: `One consistent on-brand customer for ${ctx.productName}, same face, age and styling in every lifestyle photo`,
    stylePrefix: `Premium commercial photography for ${ctx.productName}: ${g.world}, shallow depth of field, consistent lighting and casting`,
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
  pageUrl = '',
): { html: string; placed: number; videos: number } {
  let out = html;
  const slots = collectRestyleSlots(out, 24, pageUrl);
  const imgSlots = slots.filter((s) => s.kind !== 'video');
  const videoSlots = slots.filter((s) => s.kind === 'video');
  const paints: PaintedMedia[] = [];
  let placed = 0;
  let vids = 0;
  for (const { slot, item } of matchLandingMediaToSlots(imgSlots, stills, used)) {
    if (!item?.storedUrl) continue;
    if (typeof slot.domIndex === 'number') {
      paints.push({ tag: slot.domTag === 'video' ? 'video' : 'img', index: slot.domIndex, url: item.storedUrl });
    }
    out = replaceMediaUrl(out, slot.src, item.storedUrl, pageUrl);
    placed++;
  }
  for (const { slot, item } of matchLandingMediaToSlots(videoSlots, videos, used)) {
    if (!item?.storedUrl) continue;
    if (typeof slot.domIndex === 'number') {
      paints.push({ tag: 'video', index: slot.domIndex, url: item.storedUrl });
    }
    out = replaceMediaUrl(out, slot.src, item.storedUrl, pageUrl);
    vids++;
  }
  if (paints.length) out = applyPaintedMedia(out, paints);
  if (paints.length) out = injectRestyleMediaScript(out, paints);
  return { html: out, placed, videos: vids };
}

/** Internal restyle: unique poster per <video>, swap src with our landing
 *  videos when we have them. GPT Image cannot invent a new MP4 — a new
 *  poster + optional src swap is what actually changes the clip on the page. */
async function restyleVideos(
  sb: SupabaseClient,
  html: string,
  ctx: SwipeCtx,
  page: SwipePage,
  budget: { imagesLeft: number },
  deadline: number,
): Promise<{ html: string; posters: number; swapped: number }> {
  let out = html;
  let posters = 0;
  let swapped = 0;
  const slots = collectVideos(out);
  if (!slots.length) return { html: out, posters, swapped };

  for (let i = 0; i < slots.length; i++) {
    if (budget.imagesLeft <= 0 || Date.now() > deadline - 50_000) break;
    const slot = slots[i];
    const lookFor = slot.src;
    const unusedVid = ctx.landingVideos.find((v) => v.storedUrl && !ctx.mediaUsed.has(v.storedUrl));
    if (unusedVid) {
      out = replaceImageSrc(out, lookFor, unusedVid.storedUrl);
      ctx.mediaUsed.add(unusedVid.storedUrl);
      swapped++;
    }
    const spec = ctx.restyle;
    const prompt = spec
      ? `Unique video poster ${i + 1}/${slots.length} for a ${slot.section} clip. ${spec.stylePrefix}. Casting: ${spec.avatar}. Product: ${ctx.productName}. Cinematic still, no competitor brands.`
      : `Unique cinematic still ${i + 1} for ${ctx.productName} (${slot.section}). No competitor brands.`;
    const falUrl = await falGenerateImageUrl(
      IMG_MODEL_T2I,
      { num_images: 1, output_format: 'png', quality: 'medium', prompt: prompt.slice(0, 1800), image_size: 'landscape_16_9' },
      90_000,
      () => touchPage(sb, page.funnelPageId, `Video ${i + 1}/${slots.length} — new poster…`),
    );
    if (!falUrl) continue;
    const stored = await storeGeneratedImage(sb, ctx.projectId, falUrl, 800 + i) || falUrl;
    const needle = unusedVid?.storedUrl || lookFor;
    const blockRe = /<video\b[\s\S]*?<\/video>/gi;
    out = out.replace(blockRe, (block) => {
      if (!block.includes(needle) && !block.includes(lookFor)) return block;
      if (/\bposter\s*=/i.test(block)) {
        posters++;
        return block.replace(/(\bposter\s*=\s*["'])([^"']+)(["'])/i, `$1${stored}$3`);
      }
      posters++;
      return block.replace(/<video\b/i, `<video poster="${stored}"`);
    });
    budget.imagesLeft--;
    await persistHtml(sb, page.funnelPageId, 'swiped', out, ctx.ownerUserId);
  }
  return { html: out, posters, swapped };
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
  const system = `You are a senior direct-response creative director. The generator will EDIT the original photo (image-to-image): same composition, new visual world for OUR product.

Detect the FORMAT (before/after split-frame, product hero/packshot, lifestyle, ingredient close-up, mechanism diagram, infographic, testimonial portrait, press clipping, UGC, comparison). Never default to a before/after unless the original truly is one. No competitor brand names.

OUR PRODUCT: ${ctx.productName}
${ctx.productContext ? `PRODUCT CONTEXT:\n${ctx.productContext.slice(0, 3000)}` : ''}
${ctx.market ? `TARGET MARKET: ${ctx.market} — any text painted inside the image MUST be in this market's local language.` : ''}
${spec ? `VISUAL WORLD (must match every image): ${spec.stylePrefix}\nCASTING (same person in every lifestyle shot): ${spec.avatar}\nPALETTE: ${spec.primary} / ${spec.secondary} / ${spec.accent}` : ''}

Return STRICT JSON only:
{"product_shot": true|false, "format": "...", "prompt": "..."}
"prompt" = edit instructions: keep framing/crop/layout, restyle into our world, put OUR product where theirs was.
Set "product_shot": true ONLY for a packshot/hero of the competitor's own product (bottle, jar, box, device) — we will drop in OUR real product photo.`;

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
    // Never stamp the same product photo on every packshot — that made
    // the whole page look like one repeated image. Use it only as a
    // reference for I2I so each slot stays a unique frame.
    if (analysis.productShot && ctx.mainImageUrl) productSwaps++;

    const isGif = /\.gif(\?|#|$)/i.test(img.src) || /gif/i.test(img.alt);
    const sourceRef = absSrc && /^https?:\/\//i.test(absSrc) ? absSrc : '';
    const hosted = !isGif && sourceRef
      ? (await hostImageForFal(sb, ctx.projectId, sourceRef, start + processed)) || ''
      : '';
    const refs = [hosted, analysis.productShot ? ctx.mainImageUrl : null].filter((u): u is string => {
      if (!u) return false;
      return /^https?:\/\//i.test(u) || u.startsWith('data:image/');
    });
    const slotHint = `Unique frame ${start + processed + 1}/${images.length} (${img.section || 'section'}, ${isGif ? 'GIF' : analysis.format}). Do NOT reuse a previous composition.`;
    const i2iPrompt = spec
      ? `${slotHint} Keep the EXACT composition, camera angle, crop and layout of image 1. Restyle the entire visual world: ${spec.stylePrefix}. Casting: ${spec.avatar}. Replace any competitor product with ${ctx.productName}. ${analysis.prompt}`
      : `${slotHint} Keep the EXACT composition of image 1. Recreate it for ${ctx.productName}. ${analysis.prompt}`;
    const t2iPrompt = spec
      ? `${slotHint} ${spec.stylePrefix}. Casting: ${spec.avatar}. ${analysis.prompt} Product: ${ctx.productName}.`
      : `${slotHint} ${analysis.prompt}`;
    const tick = () => touchPage(sb, page.funnelPageId, `Photo ${start + processed}/${images.length} — generating…`);
    const common = { num_images: 1, output_format: 'png', quality: 'medium' as const };
    let falUrl: string | null = null;
    if (restyle && !isGif && refs.length && Date.now() < deadline - 70_000) {
      falUrl = await falGenerateImageUrl(
        IMG_MODEL_I2I,
        { ...common, prompt: i2iPrompt.slice(0, 1800), image_urls: refs, image_size: 'auto' },
        90_000,
        tick,
      );
    }
    if (!falUrl && Date.now() < deadline - 50_000) {
      falUrl = await falGenerateImageUrl(
        IMG_MODEL_T2I,
        { ...common, prompt: t2iPrompt.slice(0, 1800), image_size: falImageSize(img) },
        120_000,
        tick,
      );
    }
    if (!falUrl) {
      console.warn(`[swipe] photo ${start + processed}/${images.length} failed`);
      await touchPage(sb, page.funnelPageId, `Photo ${start + processed}/${images.length} failed — generating next…`);
      continue;
    }
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

async function markFailed(
  sb: SupabaseClient,
  pageId: string,
  msg: string,
): Promise<void> {
  const html = await loadSavedHtml(sb, pageId, 'swiped');
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    swipe_status: 'failed',
    swipe_result: html
      ? `${msg.slice(0, 220)} — copy is saved, open preview.`
      : msg.slice(0, 400),
  };
  if (html) {
    patch.swiped_data = {
      htmlUrl: funnelHtmlUrl(pageId, 'swiped'),
      htmlSkipped: true,
      htmlLength: html.length,
      swipedAt: now,
      methodUsed: 'chimera-protocol-auto-swipe',
      newTitle: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '',
    };
  }
  await sb.from('funnel_pages').update(patch).eq('id', pageId)
    .then(() => undefined, () => undefined);
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
  } else if (ctx.skipTexts) {
    html = await loadSavedHtml(sb, page.funnelPageId, 'swiped');
    originalHtml = await loadSavedHtml(sb, page.funnelPageId, 'cloned');
    if (!html) throw new Error('Clone/Swipe rewrite missing — run Rewrite first');
    originalTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || page.name;
    newTitle = originalTitle;
    replacements = (html.match(/"from"\s*:/g) || []).length;
    textsCount = replacements;
    if (ctx.imageMode === 'internal') {
      await touchPage(sb, page.funnelPageId, 'Clone/Swipe copy loaded — palette + photos/gifs/videos…');
      if (!ctx.restyle) ctx.restyle = await buildRestyleSpec(originalHtml || html, ctx);
      if (!ctx.restyle) ctx.restyle = fallbackRestyleSpec(ctx, topPageHex(originalHtml || html));
      html = applyTheme(html, ctx.restyle);
    }
    await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);
    await touchPage(sb, page.funnelPageId, 'Editing photos, GIFs and videos…');
  } else {
    html = await loadSourceHtml(sb, page);
    if (!html) throw new Error('no source HTML (saved snapshot missing and live fetch failed)');
    html = ensureBaseHref(html, page.sourceUrl);
    if (ctx.imageMode === 'internal') {
      await touchPage(sb, page.funnelPageId, 'Inlining template CSS…');
      html = await inlineExternalStyles(html, page.sourceUrl);
    }
    originalHtml = html;
    originalTitle = originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
    await persistHtml(sb, page.funnelPageId, 'cloned', originalHtml, ctx.ownerUserId);

    // Texts = Clone/Swipe. Chimera does not replace that engine.
    if (/data-swipe-replacer/i.test(originalHtml)) {
      html = originalHtml;
      replacements = (originalHtml.match(/"from"\s*:/g) || []).length;
      textsCount = replacements;
      newTitle = originalHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
      await touchPage(sb, page.funnelPageId, 'Clone/Swipe copy already on the page — colors + photos next…');
      await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);
    } else {
      await touchPage(sb, page.funnelPageId, 'Clone/Swipe rewrite (same engine as Rewrite)…');
      const viaApi = await runCloneSwipeApi(originalHtml, ctx);
      if (viaApi) {
        html = viaApi.html;
        replacements = viaApi.replacements;
        textsCount = viaApi.totalTexts;
        newTitle = viaApi.newTitle;
        await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);
        await touchPage(sb, page.funnelPageId, `Clone/Swipe: ${replacements}/${textsCount} texts rewritten…`);
      } else {
        const texts = collectSwipeTexts(originalHtml);
        textsCount = texts.length;
        await touchPage(sb, page.funnelPageId, textsCount
          ? `Clone/Swipe API busy — rewriting ${textsCount} texts locally…`
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
          let persistChain = Promise.resolve();
          const persistDraft = (rewrites: Map<number, string>) => {
            persistChain = persistChain.then(async () => {
              const applied = applyRewrites(originalHtml, texts, rewrites);
              html = applied.html;
              replacements = applied.replacements;
              newTitle = applied.newTitle;
              changes = applied.changes;
              await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);
              await touchPage(sb, page.funnelPageId, `${replacements}/${textsCount} texts now on the page…`);
            });
            return persistChain;
          };
          const rewrites = await rewriteAllTexts(system, texts, textDeadline, persistDraft);
          await persistDraft(rewrites);
        }
      }
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
      `${replacements}/${textsCount} texts rewritten${ctx.restyle ? ', new visual world' : ''} — editing photos…`);
  }

  let imgRes = { html, generated: 0, productSwaps: 0, analyzed: 0, placed: 0, videos: 0, remaining: 0, total: 0, processed: 0 };
  const photoMinutesLeft = deadline - Date.now();
  const photosNeedOwnRun = ctx.imageMode === 'internal' && !resume && photoMinutesLeft < 200_000;
  try {
    if (ctx.imageMode === 'affiliate') {
      const offer = pickOfferLandingMedia(
        [...ctx.landingStills, ...ctx.landingVideos],
        ctx.productName,
      );
      const stills = offer.filter((m) => m.kind === 'image' || m.kind === 'gif');
      const videos = offer.filter((m) => m.kind === 'video');
      if (stills.length || videos.length) {
        const applied = applyAffiliateMedia(html, stills, videos, ctx.mediaUsed, page.sourceUrl || '');
        html = applied.html;
        imgRes = { html, generated: 0, productSwaps: 0, analyzed: 0, placed: applied.placed, videos: applied.videos, remaining: 0, total: 0, processed: 0 };
      }
    } else if (photosNeedOwnRun) {
      const n = collectImages(html, page.sourceUrl, true).length;
      imgRes = { html, generated: 0, productSwaps: 0, analyzed: 0, placed: 0, videos: 0, remaining: n, total: n, processed: 0 };
      await touchPage(sb, page.funnelPageId, `${replacements}/${textsCount} texts ready — starting photos next…`);
    } else {
      const batch = await swipeImages(sb, html, ctx, page, budget, deadline, ctx.landingStills, {
        startOffset: imageOffset,
        maxThisBatch: IMAGE_BATCH,
      });
      html = batch.html;
      imgRes = { ...batch, placed: 0, videos: 0 };
      if (batch.remaining <= 0 && ctx.imageMode === 'internal' && Date.now() < deadline - 50_000) {
        const vids = await restyleVideos(sb, html, ctx, page, budget, deadline);
        html = vids.html;
        imgRes.videos = vids.swapped + vids.posters;
      }
    }
  } catch (e) {
    console.warn('[swipe] image swipe failed:', (e as Error).message);
    const n = collectImages(html, page.sourceUrl, true).length;
    imgRes.remaining = Math.max(imgRes.remaining, n - imageOffset);
    imgRes.total = n;
  }

  await persistHtml(sb, page.funnelPageId, 'swiped', html, ctx.ownerUserId);

  let done = ctx.imageMode === 'affiliate' || imgRes.remaining <= 0 || budget.imagesLeft <= 0;
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
  let { data: project, error: projectErr } = await sb
    .from('projects')
    .select('name, description, brief, brief_files, market_research, owner_user_id, domain')
    .eq('id', projectId)
    .single();
  if (projectErr && /brief_files/i.test(projectErr.message || '')) {
    const retry = await sb
      .from('projects')
      .select('name, description, brief, market_research, owner_user_id, domain')
      .eq('id', projectId)
      .single();
    project = retry.data;
  }
  const cap = (s: string, n = DOC_CAP) => (s.length > n ? s.slice(0, n) : s);
  const productName = String(project?.name || 'Our product');
  const description = String(project?.description || '').trim();
  // Same as Clone/Swipe getProjectBriefText: prefer brief_files blob, else brief TEXT.
  const briefFromFiles = extractSectionContent(
    (project as { brief_files?: unknown } | null)?.brief_files,
  ).trim();
  const briefFromCol = extractSectionContent(project?.brief).trim();
  const brief = cap(briefFromFiles || briefFromCol);
  const research = cap(extractSectionContent(project?.market_research).trim());
  const parts: string[] = [];
  if (project?.name) parts.push(`PROJECT: ${project.name}`);
  if (project?.domain) parts.push(`DOMAIN: ${String(project.domain)}`);
  if (description) parts.push(`DESCRIPTION:\n${description}`);
  if (brief) parts.push(`BRIEF (use this as the primary source of truth for tone, positioning and value props):\n${brief}`);
  if (research) parts.push(`MARKET RESEARCH:\n${research}`);
  log(`context brief=${brief.length}c research=${research.length}c desc=${description.length}c`);
  let landingItems = downloadedLandingMedia(await listLandingMedia(sb, projectId));
  if (!landingItems.length) {
    try {
      await extractLandingMediaForProject(sb, projectId);
      landingItems = downloadedLandingMedia(await listLandingMedia(sb, projectId));
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
    description,
    brief,
    research,
    market,
    mainImageUrl,
    imageMode,
    landingStills,
    landingVideos,
    mediaUsed: new Set<string>(incomingUsed),
    restyle: incomingRestyle && incomingRestyle.stylePrefix ? incomingRestyle : null,
    ownerUserId: typeof project?.owner_user_id === 'string' ? project.owner_user_id : null,
    skipTexts: body.skipTexts === true,
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
          await markFailed(sb, p.funnelPageId, msg);
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
    await markFailed(sb, page.funnelPageId, msg);
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
            skipTexts: ctx.skipTexts,
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
