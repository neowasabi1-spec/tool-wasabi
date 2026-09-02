import { createClient } from '@supabase/supabase-js';
import { getCoreKnowledge, getKnowledgeForTask } from '../../src/knowledge/copywriting';
import { encodeLexiconParam, parseDiscoveryLexicon } from '../../src/lib/competitor-relevance';

/**
 * Background function (up to 15 min) that RUNS the Project Autopilot pipeline
 * end-to-end. It performs the AI calls + Supabase writes ITSELF.
 *
 * Why not call the Next.js `/api/pipeline/step` route like before? Because
 * Netlify kills internal function-to-function HTTP calls at ~26s ("terminated"
 * / 504 Inactivity), which left every step stuck as "running". A background
 * function has a 15-minute budget and no such cap, so we do the work here and
 * the only network calls are to Anthropic + Supabase (both external).
 *
 * Body: { jobId }
 */

const STEP_ORDER = ['market_research', 'brief', 'competitor', 'angle', 'ads', 'landing', 'swipe'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-4-8';
const STEP_OUTPUT_PREVIEW_CHARS = 16000;

interface PipelineInput {
  product?: string;
  competitorLink?: string;
  description?: string;
  market?: string;
  language?: string;
  /** Optional funnel template URL to use as design/copy reference for the
   *  landing mockup (the user picks it in the launcher). */
  templateUrl?: string;
  /** Optional saved funnel id (archived_funnels). The final step READS its
   *  steps to know how many products to generate: 1 main + one per upsell/
   *  downsell page. The number is derived from the funnel, never guessed. */
  funnelId?: string;
  funnelStepIndexes?: number[];
  funnelSteps?: Array<{
    index: number;
    name: string;
    pageType: string;
    isUpsell?: boolean;
    url?: string;
    pageId?: string;
    htmlUrl?: string;
  }>;
}

interface StepState {
  key: string;
  label?: string;
  status?: string;
  summary?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  [k: string]: unknown;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) throw new Error('Supabase env (URL / SERVICE_ROLE_KEY) missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type SupabaseClient = ReturnType<typeof getSupabase>;

// ---------------------------------------------------------------------------
// Section blob helpers (mirror src/lib/project-sections.ts so the UI reads it)
// ---------------------------------------------------------------------------

interface SectionFile { name: string; content: string; size: number; type: string; uploadedAt: string; }

function buildSectionContent(files: SectionFile[], notes: string): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f?.content?.trim()) continue;
    parts.push(`=== FILE: ${f.name} ===\n\n${f.content.trim()}`);
  }
  if (notes?.trim()) parts.push(`\n\n=== NOTES ===\n\n${notes.trim()}`);
  return parts.join('\n').trim();
}

function toSectionBlob(fileName: string, content: string) {
  const file: SectionFile = {
    name: fileName,
    content,
    size: content.length,
    type: 'ai/markdown',
    uploadedAt: new Date().toISOString(),
  };
  return { files: [file], notes: '', content: buildSectionContent([file], '') };
}

function sectionContentFrom(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') {
    const t = val.trim();
    if (t.startsWith('{')) {
      try {
        const p = JSON.parse(t);
        if (p && typeof p === 'object' && typeof p.content === 'string') return p.content;
      } catch { /* plain string */ }
    }
    return val;
  }
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if (typeof o.content === 'string' && o.content) return o.content;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Anthropic call with Knowledge Base injection + prompt caching
// ---------------------------------------------------------------------------

type CopyTask = 'general' | 'vsl' | 'pdp' | 'headline' | 'ad' | 'advertorial' | 'mechanism';

interface ClaudeOpts {
  task?: CopyTask;
  instructions: string;
  brief?: string;
  marketResearch?: string;
  userMessage: string;
  maxTokens: number;
  /** Per-call fetch timeout. Defaults to 300s for long generations. */
  timeoutMs?: number;
}

async function callClaude(opts: ClaudeOpts): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // System blocks: instructions + Tier1 KB (cached), Tier2 KB (cached).
  // The Tier2 selection depends on the task, so ads load ad-specific
  // frameworks, landing loads pdp recipes, brief/VSL load Georgi big-ideas, etc.
  const system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
  let core = '';
  let tier2 = '';
  try { core = getCoreKnowledge().trim(); } catch { core = ''; }
  try { tier2 = getKnowledgeForTask((opts.task || 'general') as never).trim(); } catch { tier2 = ''; }

  const tier1 = [opts.instructions.trim(), core].filter(Boolean).join('\n\n---\n\n');
  system.push({ type: 'text', text: tier1, cache_control: { type: 'ephemeral' } });
  if (tier2) system.push({ type: 'text', text: tier2, cache_control: { type: 'ephemeral' } });

  // User message with brief + research prefixed.
  const sections: string[] = [];
  if (opts.brief?.trim()) sections.push('# PRODUCT BRIEF', '', opts.brief.trim());
  if (opts.marketResearch?.trim()) sections.push('# MARKET RESEARCH', '', opts.marketResearch.trim());
  sections.push('# REQUEST', '', opts.userMessage);
  const userContent = sections.join('\n\n');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

// ---------------------------------------------------------------------------
// Image generation via fal.ai — GPT Image 2 (ChatGPT Image 2), the same model
// the app's /api/generate-image route uses (FAL_KEY). text2image for the main
// product, image2image (edit) for upsells so they share the brand look.
// ---------------------------------------------------------------------------

const IMG_MODEL_T2I = process.env.PIPELINE_IMAGE_MODEL || 'openai/gpt-image-2';
const IMG_MODEL_I2I = `${IMG_MODEL_T2I}/edit`;

interface GenImage { data: Buffer; mimeType: string; }

function falKey(): string { return process.env.FAL_KEY || process.env.FAL_AI_API_KEY || ''; }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Submit a fal.ai image job and poll until it completes; returns the image
 *  URL fal hosts, or null on any failure. Runs inside the 15-min background
 *  budget, so an internal poll loop is fine (no Netlify 10s wall here). */
async function falGenerateImageUrl(
  endpoint: string,
  input: Record<string, unknown>,
  timeoutMs = 240_000,
): Promise<string | null> {
  const key = falKey();
  if (!key) return null;
  try {
    const sub = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    if (!sub.ok) { console.warn('[pipeline] fal submit', sub.status, (await sub.text()).slice(0, 300)); return null; }
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
      if (sj.status === 'ERROR') { console.warn('[pipeline] fal job error', sj.error); return null; }
    }
    console.warn('[pipeline] fal job timed out');
    return null;
  } catch (e) {
    console.warn('[pipeline] fal image threw:', (e as Error).message);
    return null;
  }
}

/** Download a generated image URL into a Buffer for permanent storage. */
async function downloadImage(url: string): Promise<GenImage | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return { data: buf, mimeType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function marketDirective(input: PipelineInput): string {
  const geo = (input.market || input.language || '').trim()
    || 'infer the target market/geography from the product description; if none is stated, assume a broad English-speaking market (US)';
  return `TARGET MARKET / GEOGRAPHY: ${geo}.
- Research the audience, competitors, buying habits, price points and regulatory context of THIS geography.
- WRITE ALL OUTPUT IN ENGLISH. This is a strategy document for the team; localization into the market's local language happens later, during ad/landing production.`;
}

function isMetaAdLibrary(url: string): boolean { return /facebook\.com\/ads\/library/i.test(url); }

/** One angle parsed out of the Angle Matrix produced by the angle step. */
interface AngleItem { name: string; body: string; }

/** Parse the Angle Matrix. Each angle starts with a markdown heading of the
 *  form "## ANGLE N — <name>" (we also tolerate "### ANGLE:" / "ANGLE:"). */
function parseAngles(raw: string): AngleItem[] {
  const lines = (raw || '').split('\n');
  const items: AngleItem[] = [];
  let cur: AngleItem | null = null;
  const headRe = /^#{2,3}\s*ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/i;
  const altRe = /^ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/i;
  for (const ln of lines) {
    const m = ln.match(headRe) || ln.match(altRe);
    if (m) {
      if (cur) items.push(cur);
      cur = { name: m[1].replace(/[*_`]/g, '').trim().slice(0, 200), body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + ln;
    }
  }
  if (cur) items.push(cur);
  return items.map((a) => ({ name: a.name, body: a.body.trim() })).filter((a) => a.name);
}

type AdPlatform = 'meta' | 'tiktok' | 'google';
interface PlatformAd { angle: string; platform: AdPlatform; text: string; }

/** Parse the multi-platform ads output. Angles are separated by a line of
 *  "---"; inside each block, platform sections are marked [META] / [TIKTOK] /
 *  [GOOGLE] (case-insensitive). */
function parseMultiPlatformAds(raw: string): PlatformAd[] {
  const out: PlatformAd[] = [];
  const blocks = (raw || '').split(/\n-{3,}\s*\n/g).map((b) => b.trim()).filter(Boolean);
  for (const b of blocks) {
    const nameM = b.match(/^#{0,3}\s*ANGLE\s*\d*\s*[—:\-–]\s*(.+?)\s*$/im);
    const angle = (nameM ? nameM[1] : 'Concept').replace(/[*_`]/g, '').trim().slice(0, 200);
    const markers: Array<{ p: AdPlatform; re: RegExp }> = [
      { p: 'meta', re: /\[\s*META\s*\]/i },
      { p: 'tiktok', re: /\[\s*TIKTOK\s*\]/i },
      { p: 'google', re: /\[\s*GOOGLE\s*\]/i },
    ];
    const hits = markers
      .map((m) => ({ p: m.p, idx: b.search(m.re) }))
      .filter((h) => h.idx >= 0)
      .sort((a, c) => a.idx - c.idx);
    if (hits.length === 0) {
      // No platform markers — keep the whole block under META so nothing is lost.
      out.push({ angle, platform: 'meta', text: b });
      continue;
    }
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].idx;
      const end = i + 1 < hits.length ? hits[i + 1].idx : b.length;
      const text = b.slice(start, end).replace(/^\[[^\]]+\]\s*/, '').trim();
      if (text) out.push({ angle, platform: hits[i].p, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real competitor search (Facebook Ad Library via Apify)
// ---------------------------------------------------------------------------

/** Map a free-text market/language hint to an ISO country code for the FB
 *  Ad Library `country` filter. Defaults to IT. */
function countryFromMarket(input: PipelineInput): string {
  const s = `${input.market || ''} ${input.language || ''} ${input.description || ''}`.toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/german|deutsch|tedesc|germani|\bde\b/, 'DE'],
    [/franc|french|français|\bfr\b/, 'FR'],
    [/spa(gn|in|ño)|espa|\bes\b/, 'ES'],
    [/portug|\bpt\b|brasil|brazil/, 'PT'],
    [/nederl|dutch|holland|\bnl\b/, 'NL'],
    [/united states|\busa\b|\bus\b|america|english/, 'US'],
    [/united kingdom|\buk\b|england|britain/, 'GB'],
    [/ital|\bit\b/, 'IT'],
  ];
  for (const [re, cc] of table) if (re.test(s)) return cc;
  return 'IT';
}

function fbAdLibrarySearchUrl(keyword: string, country: string): string {
  const q = encodeURIComponent(keyword.trim());
  // keyword_exact: the phrase must appear. keyword_unordered matches ANY
  // word ("coffee" → coffee shops, machines, grocery).
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${q}&search_type=keyword_exact&media_type=all`;
}

/** Start an Apify FB Ad Library run (mirrors src/lib/apify.ts startAdsLibraryRun).
 *  Ingestion is async via /api/apify/webhook. */
async function startApifyAdsRun(adsLibraryUrl: string, count: number, webhookUrl: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  if (!token) return { ok: false, error: 'APIFY_KEY not configured' };
  const actor = process.env.APIFY_FB_ADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
  const n = Math.min(Math.max(count || 20, 1), 200);
  const input: Record<string, unknown> = {
    urls: [{ url: adsLibraryUrl, method: 'GET' }],
    startUrls: [{ url: adsLibraryUrl }],
    adLibraryUrl: adsLibraryUrl,
    count: n, maxResults: n, resultsLimit: n,
    scrapeAdDetails: true, scrapePageAds: true, activeStatus: 'active',
  };
  const webhooks = Buffer.from(JSON.stringify([{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: webhookUrl,
  }]), 'utf8').toString('base64');
  const url = `https://api.apify.com/v2/acts/${actor}/runs?token=${encodeURIComponent(token)}&webhooks=${encodeURIComponent(webhooks)}`;
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: json?.error?.message || `Apify start failed (${resp.status})` };
    const runId = json?.data?.id;
    if (!runId) return { ok: false, error: 'No run id returned by Apify' };
    return { ok: true, runId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Generic Apify actor start with a run webhook (used for TikTok + Google). */
async function startApifyRun(actor: string, input: Record<string, unknown>, webhookUrl: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  if (!token) return { ok: false, error: 'APIFY_KEY not configured' };
  const actorId = actor.trim().replace('/', '~');
  const webhooks = Buffer.from(JSON.stringify([{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: webhookUrl,
  }]), 'utf8').toString('base64');
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}&webhooks=${encodeURIComponent(webhooks)}`;
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: json?.error?.message || `Apify start failed (${resp.status})` };
    const runId = json?.data?.id;
    if (!runId) return { ok: false, error: 'No run id returned by Apify' };
    return { ok: true, runId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Start a TikTok Ad Library / Creative Center keyword run. */
async function startApifyTiktokRun(keyword: string, country: string, count: number, webhookUrl: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const actor = process.env.APIFY_TIKTOK_ADS_ACTOR || 'aiscraperdev~tiktok-ads-library-scraper';
  const n = Math.min(Math.max(count || 20, 1), 200);
  const region = (country || '').trim() || 'all';
  const input: Record<string, unknown> = {
    searchQuery: keyword, query: keyword, keyword,
    // 'ad_library' is keyword-filtered (verified advertisers, EU/UK/TR) →
    // relevant competitors, vs 'creative_center' top-ads which ignore the query.
    source: 'ad_library', region, regions: [region], countries: [region],
    adType: 'all', maxResults: n, maxResultsPerQuery: n, resultsLimit: n, count: n,
  };
  return startApifyRun(actor, input, webhookUrl);
}

/** Start a Google Ads Transparency Center keyword run. */
async function startApifyGoogleRun(keyword: string, region: string, count: number, webhookUrl: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const actor = process.env.APIFY_GOOGLE_ADS_ACTOR || 'jaybird~google-ads-transparency-scraper';
  const n = Math.min(Math.max(count || 20, 1), 200);
  const reg = (region || '').trim() || 'anywhere';
  const input: Record<string, unknown> = {
    queries: [keyword], searchQuery: keyword, searchTargets: [keyword],
    region: reg, regions: [reg], dateRangePreset: 'LAST_30_DAYS',
    adFormat: 'ALL', enrichLandingPages: true, scrapeDetails: true,
    maxResults: n, maxAdsPerTarget: n, maxAdvertisersPerKeyword: 8,
  };
  return startApifyRun(actor, input, webhookUrl);
}

function siteBaseUrl(): string {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
}

/** Fetch a template/landing page's readable content via Jina Reader (plain
 *  fetch, no headless browser). Best-effort; returns '' on failure. */
async function fetchTemplateReference(url: string): Promise<string> {
  if (!url) return '';
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'text' };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) return '';
    const text = await resp.text();
    return text.slice(0, 12_000);
  } catch { return ''; }
}

/** Insert a funnel_steps row so the output is visible in the ProjectHub
 *  Funnel tab (which renders result_content, HTML included). */
async function createFunnelStep(supabase: SupabaseClient, projectId: string, opts: {
  stepNumber: number; pageName: string; stepType: string; resultContent: string; flowName?: string;
}) {
  const { error } = await supabase.from('funnel_steps').insert({
    project_id: projectId,
    step_number: opts.stepNumber,
    page_name: opts.pageName,
    step_type: opts.stepType,
    status: 'ready',
    auto_gen: true,
    flow_name: opts.flowName || 'Chimera Protocol',
    result_content: opts.resultContent,
  });
  if (error) throw new Error(`Failed to save funnel step: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Section files — the ProjectHub "General Brief" tab renders FILES from
// `project_files` (Supabase Storage bucket `project-files`) filtered by
// `file_type` (e.g. market_research, pb_frontend), NOT the JSONB columns.
// So the pipeline must write its docs as project_files rows to be visible.
// ---------------------------------------------------------------------------

const PROJECT_FILES_BUCKET = 'project-files';
let _bucketEnsured = false;

async function ensureProjectFilesBucket(supabase: SupabaseClient): Promise<void> {
  if (_bucketEnsured) return;
  try {
    const { error } = await supabase.storage.createBucket(PROJECT_FILES_BUCKET, {
      public: true,
      fileSizeLimit: 52428800,
    });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn('[pipeline] ensureBucket:', error.message);
    }
  } catch (e) { console.warn('[pipeline] ensureBucket threw:', (e as Error).message); }
  _bucketEnsured = true;
}

/** Save a markdown document into the right ProjectHub section as a real file.
 *  Replaces any previous Autopilot-generated file of the same type (marked by
 *  the "Autopilot — " prefix) so re-runs don't pile up duplicates, while
 *  leaving the user's own uploads untouched. */
async function saveSectionFile(
  supabase: SupabaseClient,
  projectId: string,
  fileType: string,
  displayName: string,
  markdown: string,
): Promise<boolean> {
  try {
    await ensureProjectFilesBucket(supabase);
    const originalName = `Chimera Protocol — ${displayName}`;

    // Clean up previous auto-generated file(s) of this type (new + legacy prefix).
    const { data: prev } = await supabase
      .from('project_files')
      .select('id, file_path')
      .eq('project_id', projectId)
      .eq('file_type', fileType)
      .or('original_name.like.Chimera Protocol — %,original_name.like.Autopilot — %');
    if (Array.isArray(prev) && prev.length) {
      const paths = prev.map((p) => p.file_path as string).filter(Boolean);
      if (paths.length) await supabase.storage.from(PROJECT_FILES_BUCKET).remove(paths).catch(() => {});
      await supabase.from('project_files').delete().in('id', prev.map((p) => p.id));
    }

    const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') + '.md';
    const objectKey = `${projectId}/${fileType}/${Date.now()}_${safe}`;
    const buf = Buffer.from(markdown, 'utf-8');
    const { error: upErr } = await supabase.storage
      .from(PROJECT_FILES_BUCKET)
      .upload(objectKey, buf, { contentType: 'text/markdown; charset=utf-8', upsert: false });
    if (upErr) { console.warn('[pipeline] section file upload failed:', upErr.message); return false; }

    const { error: insErr } = await supabase.from('project_files').insert({
      project_id: projectId,
      file_type: fileType,
      file_path: objectKey,
      original_name: `${originalName}.md`,
    });
    if (insErr) {
      console.warn('[pipeline] project_files insert failed:', insErr.message);
      await supabase.storage.from(PROJECT_FILES_BUCKET).remove([objectKey]).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[pipeline] saveSectionFile threw:', (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Product images — main product + upsells (count derived from the funnel)
// ---------------------------------------------------------------------------

/** Upload a generated product image into the project-files bucket + register a
 *  `project_files` row (file_type product_image). Returns the public URL. */
async function saveProductImage(
  supabase: SupabaseClient,
  projectId: string,
  label: string,
  img: GenImage,
): Promise<string | null> {
  try {
    await ensureProjectFilesBucket(supabase);
    const ext = /jpeg|jpg/.test(img.mimeType) ? 'jpg' : /webp/.test(img.mimeType) ? 'webp' : 'png';
    const safe = `Chimera Protocol — ${label}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${projectId}/product_image/${Date.now()}_${safe}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(PROJECT_FILES_BUCKET)
      .upload(objectKey, img.data, { contentType: img.mimeType, upsert: false });
    if (upErr) { console.warn('[pipeline] product image upload failed:', upErr.message); return null; }
    const { error: insErr } = await supabase.from('project_files').insert({
      project_id: projectId,
      file_type: 'product_image',
      file_path: objectKey,
      original_name: `${safe}.${ext}`,
    });
    if (insErr) {
      console.warn('[pipeline] product_files insert failed:', insErr.message);
      await supabase.storage.from(PROJECT_FILES_BUCKET).remove([objectKey]).catch(() => {});
      return null;
    }
    const { data: pub } = supabase.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(objectKey);
    return pub?.publicUrl || null;
  } catch (e) {
    console.warn('[pipeline] saveProductImage threw:', (e as Error).message);
    return null;
  }
}

interface FunnelProducts {
  total: number;
  upsells: number;
  pages: Array<{ name: string; type: string }>;
  funnelName: string;
  /** Main page URL (used as the landing design reference when set). */
  templateUrl: string;
  /** Main page saved HTML — offline design reference when no URL is available. */
  templateHtml: string;
}

/** Read the SELECTED funnel and derive both:
 *   - how many products it needs (1 main + one per upsell/downsell page), and
 *   - a landing DESIGN REFERENCE from its main page (URL or saved HTML).
 *  Everything comes from the funnel's own steps — never guessed. Null when no
 *  funnel is selected. */
const UPSELL_PAGE_RE = /upsell|downsell|\boto\b|bump/i;

function selectedArchiveSteps(input: PipelineInput, dbSteps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (Array.isArray(input.funnelSteps) && input.funnelSteps.length) {
    return input.funnelSteps.map((s) => ({
      name: s.name,
      page_type: s.pageType,
      step_type: s.pageType,
      url_to_swipe: s.url || '',
      page_id: s.pageId || '',
      cloned_data: s.htmlUrl ? { htmlUrl: s.htmlUrl, source_url: s.url || '' } : { source_url: s.url || '' },
    }));
  }
  const idx = Array.isArray(input.funnelStepIndexes) ? new Set(input.funnelStepIndexes) : null;
  if (!idx || !idx.size) return dbSteps;
  return dbSteps.filter((_, i) => idx.has(i));
}

async function loadFunnelProducts(supabase: SupabaseClient, input: PipelineInput): Promise<FunnelProducts | null> {
  if (!input.funnelId && !(input.funnelSteps && input.funnelSteps.length)) return null;
  try {
    let dbSteps: Array<Record<string, unknown>> = [];
    let funnelName = '';
    if (input.funnelId) {
      const { data } = await supabase
        .from('archived_funnels')
        .select('id, name, steps, total_steps')
        .eq('id', input.funnelId)
        .single();
      if (data) {
        funnelName = String(data.name || '');
        dbSteps = Array.isArray(data.steps) ? (data.steps as Array<Record<string, unknown>>) : [];
      }
    }
    const steps = selectedArchiveSteps(input, dbSteps);
    if (!steps.length) return null;
    const pages = steps.map((s) => ({
      name: String(s?.name || ''),
      type: String(s?.page_type || s?.step_type || '').toLowerCase(),
    }));
    const upsells = pages.filter((p) => UPSELL_PAGE_RE.test(p.type)).length;

    // Pick the best step to imitate for the landing: prefer a sales/landing/
    // presell/advertorial page; otherwise the first step with a real URL.
    const rank = (t: string) =>
      /sales|\bvsl\b/i.test(t) ? 5 : /landing|\blp\b/i.test(t) ? 4 : /presell|advertorial/i.test(t) ? 3 : /checkout/i.test(t) ? 1 : 2;
    let best: Record<string, unknown> | null = null;
    let bestRank = -1;
    for (const s of steps) {
      const t = String(s?.page_type || s?.step_type || '').toLowerCase();
      // Skip pure upsell/thank-you pages as the landing reference.
      if (/upsell|downsell|\boto\b|bump|thank|receipt/i.test(t)) continue;
      const r = rank(t);
      if (r > bestRank) { bestRank = r; best = s; }
    }
    if (!best && steps.length) best = steps[0];
    const cloned = (best?.cloned_data && typeof best.cloned_data === 'object' ? best.cloned_data : {}) as Record<string, unknown>;
    const url = String(best?.url_to_swipe || '');
    const templateUrl = /^https?:\/\//i.test(url) ? url : '';
    const templateHtml = typeof cloned.html === 'string' ? (cloned.html as string) : '';

    const hasMain = pages.some((p) => !UPSELL_PAGE_RE.test(p.type));
    const total = (hasMain ? 1 : 0) + upsells || 1;
    return { total, upsells, pages, funnelName: funnelName || 'Funnel', templateUrl, templateHtml };
  } catch {
    return null;
  }
}

interface ProductSpec { main: { name: string; imagePrompt: string }; upsells: Array<{ name: string; relation: string; imagePrompt: string }>; }

/** Parse the strict-JSON product line from Claude, tolerating code fences and
 *  padding/truncating the upsell list to the exact count the funnel requires. */
function parseProductSpec(raw: string, upsellCount: number, fallbackName: string): ProductSpec {
  let main = { name: fallbackName, imagePrompt: `${fallbackName} product packshot` };
  let upsells: Array<{ name: string; relation: string; imagePrompt: string }> = [];
  try {
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    const obj = JSON.parse(start >= 0 && end > start ? jsonStr.slice(start, end + 1) : jsonStr);
    if (obj?.main?.name) main = { name: String(obj.main.name).slice(0, 120), imagePrompt: String(obj.main.imagePrompt || main.imagePrompt).slice(0, 800) };
    if (Array.isArray(obj?.upsells)) {
      upsells = obj.upsells.slice(0, upsellCount).map((u: Record<string, unknown>) => ({
        name: String(u?.name || 'Upsell').slice(0, 120),
        relation: String(u?.relation || '').slice(0, 200),
        imagePrompt: String(u?.imagePrompt || `${main.name} related product packshot`).slice(0, 800),
      }));
    }
  } catch { /* fall back to main-only */ }
  // Pad if the model under-delivered, so we always try to fill every upsell slot.
  while (upsells.length < upsellCount) {
    const n = upsells.length + 1;
    upsells.push({ name: `${main.name} — Upsell ${n}`, relation: 'related bundle/refill', imagePrompt: `${main.name} related product packshot, variant ${n}` });
  }
  return { main, upsells };
}

/** Wrap an image prompt in consistent ecommerce packshot styling. */
function buildPackshotPrompt(core: string): string {
  return `Photorealistic ecommerce product packshot. ${core}. Centered product on a clean seamless light studio background, soft natural shadow, crisp high-detail lighting, no people, no added text or logos beyond the product's own label, square framing, high resolution.`;
}

/** Generate the product line images (main + correlated upsells). Main is
 *  text-to-image; each upsell is image-to-image off the main so the whole line
 *  shares one brand look. Best-effort: returns counts + a human note. */
async function generateProductImages(
  supabase: SupabaseClient,
  projectId: string,
  input: PipelineInput,
  funnel: FunnelProducts | null,
  research: string,
  brief: string,
  productName: string,
): Promise<{ saved: number; total: number; note: string; mainImageUrl: string | null; images: Array<{ name: string; url: string; role: string }> }> {
  const upsellCount = funnel ? funnel.upsells : 0;
  const images: Array<{ name: string; url: string; role: string }> = [];

  if (!falKey()) {
    return { saved: 0, total: 1 + upsellCount, note: 'image generation skipped: FAL_KEY not configured.', mainImageUrl: null, images };
  }

  const specRaw = await callClaude({
    task: 'general',
    instructions: `You are a product designer + ecommerce merchandiser. Define a coherent PRODUCT LINE for a sales funnel: the MAIN product and EXACTLY ${upsellCount} UPSELL products that are directly RELATED to the main (same brand world — e.g. multi-pack/bulk, complementary accessory, refill, premium/bundle version). For EACH product write a photorealistic packshot image prompt describing the physical product, packaging and colors, consistent across the whole line.
Return STRICT JSON ONLY, no prose, no code fences:
{"main":{"name":"...","imagePrompt":"..."},"upsells":[{"name":"...","relation":"...","imagePrompt":"..."}]}
The "upsells" array MUST contain EXACTLY ${upsellCount} items${upsellCount === 0 ? ' (an empty array)' : ''}.`,
    brief,
    marketResearch: research,
    userMessage: `Main product: ${productName}\n${input.description ? `Description: ${input.description}\n` : ''}Market: ${marketGeo(input) || 'infer from product'}\nReturn the product line as JSON with exactly ${upsellCount} upsells.`,
    maxTokens: 2000,
  });

  const spec = parseProductSpec(specRaw, upsellCount, productName);

  let saved = 0;
  let mainImageUrl: string | null = null;
  let mainRefUrl: string | null = null; // a public URL fal can fetch for edits

  const mainFalUrl = await falGenerateImageUrl(IMG_MODEL_T2I, {
    prompt: buildPackshotPrompt(spec.main.imagePrompt),
    image_size: 'square_hd',
    quality: 'medium',
    num_images: 1,
    output_format: 'png',
  });
  if (mainFalUrl) {
    mainRefUrl = mainFalUrl;
    const dl = await downloadImage(mainFalUrl);
    if (dl) {
      const stored = await saveProductImage(supabase, projectId, `Product — ${spec.main.name}`, dl);
      if (stored) { mainImageUrl = stored; mainRefUrl = stored; saved++; images.push({ name: spec.main.name, url: stored, role: 'Main product' }); }
    }
  }

  let upIdx = 0;
  for (const up of spec.upsells) {
    upIdx++;
    const prompt = `${buildPackshotPrompt(up.imagePrompt)} It belongs to the SAME product family/brand as the reference image — keep the same palette, packaging style and branding.`;
    // If we have the main image, do an image2image edit so the upsell matches;
    // otherwise fall back to a text2image with a strong "same line" prompt.
    const upFalUrl = mainRefUrl
      ? await falGenerateImageUrl(IMG_MODEL_I2I, {
          prompt,
          image_urls: [mainRefUrl],
          image_size: 'auto',
          quality: 'medium',
          num_images: 1,
          output_format: 'png',
        })
      : await falGenerateImageUrl(IMG_MODEL_T2I, {
          prompt,
          image_size: 'square_hd',
          quality: 'medium',
          num_images: 1,
          output_format: 'png',
        });
    if (upFalUrl) {
      const dl = await downloadImage(upFalUrl);
      const stored = dl ? await saveProductImage(supabase, projectId, `Upsell ${upIdx} — ${up.name}`, dl) : null;
      const finalUrl = stored || upFalUrl;
      saved++;
      images.push({ name: up.name, url: finalUrl, role: `Upsell ${upIdx}` });
    }
  }

  const total = 1 + spec.upsells.length;
  return { saved, total, note: `${saved}/${total} product images generated.`, mainImageUrl, images };
}

// ---------------------------------------------------------------------------
// Steps — each returns { summary, output }
// ---------------------------------------------------------------------------

interface StepResult { summary: string; output: string; }

async function loadProject(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description, domain, market_research, brief, front_end, funnel')
    .eq('id', projectId)
    .single();
  if (error || !data) throw new Error(`Cannot load project ${projectId}: ${error?.message || 'not found'}`);
  return data as Record<string, unknown>;
}

/** Read back the markdown of the latest Autopilot-generated section file of a
 *  given type (e.g. the Angle Matrix saved by the angle step). Empty string if
 *  none — callers must degrade gracefully. */
async function loadSectionFileText(
  supabase: SupabaseClient,
  projectId: string,
  fileType: string,
): Promise<string> {
  try {
    const { data } = await supabase
      .from('project_files')
      .select('file_path, created_at')
      .eq('project_id', projectId)
      .eq('file_type', fileType)
      .or('original_name.like.Chimera Protocol — %,original_name.like.Autopilot — %')
      .order('created_at', { ascending: false })
      .limit(1);
    const path = data?.[0]?.file_path as string | undefined;
    if (!path) return '';
    const { data: blob } = await supabase.storage.from(PROJECT_FILES_BUCKET).download(path);
    if (!blob) return '';
    return (await blob.text()).trim();
  } catch {
    return '';
  }
}

/** Build a compact "swipe" digest of the real competitor ads already scraped
 *  into this project. Winners first (more variants / more reach = validated),
 *  so the angle + ad steps model what is actually working in THIS market. */
async function loadCompetitorSwipe(
  supabase: SupabaseClient,
  projectId: string,
  max = 14,
): Promise<string> {
  try {
    const { data: brands } = await supabase
      .from('competitor_brands')
      .select('id, name')
      .eq('project_id', projectId);
    const brandName = new Map<number, string>();
    for (const b of (brands || []) as Array<{ id: number; name: string }>) brandName.set(b.id, b.name);

    const { data: ads } = await supabase
      .from('competitor_ads')
      .select('brand_id, headline, hook, body_text, ad_variants, reach')
      .eq('project_id', projectId)
      .limit(400);
    const rows = (ads || []) as Array<{
      brand_id: number; headline?: string; hook?: string; body_text?: string;
      ad_variants?: number; reach?: number;
    }>;
    if (rows.length === 0) return '';

    const score = (r: { ad_variants?: number; reach?: number }) =>
      (Number(r.ad_variants) || 0) * 1000 + (Number(r.reach) || 0);
    rows.sort((a, b) => score(b) - score(a));

    const seen = new Set<string>();
    const lines: string[] = [];
    for (const r of rows) {
      const brand = brandName.get(r.brand_id) || 'Competitor';
      const hook = (r.hook || '').trim();
      const head = (r.headline || '').trim();
      const body = (r.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
      const key = (hook || head || body).slice(0, 80).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const variants = Number(r.ad_variants) || 0;
      const parts = [
        `• [${brand}${variants > 1 ? `, ${variants} variants` : ''}]`,
        hook ? `HOOK: ${hook.slice(0, 160)}` : '',
        head ? `HEADLINE: ${head.slice(0, 160)}` : '',
        body ? `BODY: ${body}` : '',
      ].filter(Boolean);
      lines.push(parts.join(' '));
      if (lines.length >= max) break;
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function runMarketResearch(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';

  const instructions = `You are a world-class direct-response market researcher (think Stefan Georgi + Gary Bencivenga level). Produce a COMPREHENSIVE UNIFIED RESEARCH DOCUMENT following Georgi's RMBC "Deep Research" methodology (the R in RMBC). This is the single source of truth a copywriter will use to write the entire funnel, so it must be DEEP, exhaustive and immediately usable — NOT a summary.
${marketDirective(input)}

DEPTH REQUIREMENTS (this is the difference between amateur and pro research — do not skimp):
- Aim for a 2,500–4,000 word professional dossier. Each section must be substantive, not just a bullet or two.
- Apply your knowledge base frameworks EXPLICITLY and by name where useful: Schwartz (5 Awareness Levels + 5 Sophistication Stages), Georgi Big Ideas & Unique Mechanism, Tony Flores root-cause/identity mechanisms, Evaldo's core-emotion logic, Sugarman psychological triggers, Bencivenga proof.
- Be concrete and specific to THIS product/market — never generic filler. Use the reference competitor and category to ground every claim.
- Where you infer rather than know, label it "(inference)". Where a real citation/study would be needed, label it "(needs source)".
- Write realistic Voice-of-Customer quotes as if mined from reviews/forums/Reddit/Amazon/Trustpilot for this geography.

Output clean markdown with EXACTLY these sections and sub-sections:

# 1. MARKET SNAPSHOT
- The category, its size/momentum in this geography, and why now (trends, cultural context).
- The core problem this product solves, framed the way the market experiences it.

# 2. PRODUCT / MARKET AWARENESS (Schwartz)
- Core customer & the ONE market you're targeting (be surgical).
- Awareness Level (1 Unaware → 5 Most Aware) with detailed justification AND the practical copy implication: exactly how to open and what NOT to do at this level.
- Market Sophistication Stage (1→5) with justification and the resulting angle strategy (new claim vs. mechanism vs. amplification vs. identification).

# 3. AVATAR (deep)
- A named, vivid primary avatar: demographics, psychographics, identity, self-image, aspirations.
- A detailed "day in the life" narrative (a real paragraph, not bullets) showing where the problem intrudes.
- 1–2 secondary sub-avatars worth targeting separately.

# 4. PSYCHOGRAPHIC DRIVERS
- Deep fears (5+), frustrations (5+), secret desires (5+), and status/identity anxieties.
- The trigger event that makes them finally act.
- The single DOMINANT emotion driving purchase (Evaldo logic) + the "away from" pain and the "toward" desire.
- False solutions they've already tried and why each failed them (this fuels the mechanism).

# 5. VOICE OF CUSTOMER (language mining)
- 20+ verbatim-style quotes, grouped under: Pains, Failed solutions, Desires/Dreams, Objections/Skepticism.
- The exact words, metaphors and phrases they use (so copy can mirror them).

# 6. COMPETITOR RESEARCH (teardown)
- 3–5 real competitors/alternatives in this geography. For EACH: positioning, primary claim, angle, rough price, strengths, and weaknesses.
- A "claims to swipe" list (proven claims worth modeling) and a "gaps to exploit" list.
- The positioning white space this product can own.

# 7. UNIQUE MECHANISM
- Unique Mechanism of the PROBLEM: the specific, nameable hidden root cause keeping the problem alive (give it a memorable name).
- Unique Mechanism of the SOLUTION: why THIS product uniquely breaks that loop (specific ingredient/strain/delivery/synergy), also named.
- Why this mechanism beats a louder claim at this sophistication stage.

# 8. INGREDIENT / PROOF DOSSIER (when relevant)
- Each key ingredient/component → the benefit and the claim it supports, with mechanism of action.
- Proof assets available or needed: studies, authority, demonstrations, testimonials, guarantees. Label unverified "(needs source)".

# 9. OBJECTIONS & CORE BUYING BELIEF
- 10+ objections, each with a concrete rebuttal/reframe.
- The single CORE BUYING BELIEF the copy must install for the sale to happen.

# 10. BIG IDEAS & ANGLES
- 3 distinct Big Idea candidates (Georgi style), each with a one-line articulation.
- 8–10 distinct, testable marketing angles for ads + landing. For EACH angle: the awareness level it fits, the emotional driver, and a sample hook/headline.

# 11. COPY DIRECTION SUMMARY
- The recommended lead type, tone, and the single most important thing the copy must do. A 3–5 sentence brief-of-the-brief.`;

  const userMessage = `Product: ${productName}
${input.description ? `\nProvided description:\n${input.description}` : ''}
${input.competitorLink ? `\nReference competitor link: ${input.competitorLink}` : ''}

Generate the FULL, deep RMBC-style unified research document for this product. Be exhaustive — this must be the definitive research dossier, not a summary.`;

  const content = await callClaude({ task: 'vsl', instructions, userMessage, maxTokens: 16000 });
  if (!content) throw new Error('Market research returned empty output');

  const { error } = await supabase
    .from('projects')
    // JSONB SectionData is what the generation/rewrite features CONSUME. The
    // file entry name is kept identical to the uploaded file's original_name
    // so the General Brief backfill (which dedupes by name) never duplicates it.
    .update({ market_research: toSectionBlob('Chimera Protocol — Market Research (RMBC).md', content) })
    .eq('id', projectId);
  if (error) throw new Error(`Failed to save market_research: ${error.message}`);

  // Also save as a real file so it SHOWS in the "Market Research" section of the UI.
  const fileSaved = await saveSectionFile(supabase, projectId, 'market_research', 'Market Research (RMBC)', content);

  return {
    summary: fileSaved
      ? 'RMBC market research generated — saved as a document in the Market Research section.'
      : 'RMBC market research generated and saved (file mirror failed; content is in the project).',
    output: content,
  };
}

async function runBrief(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';
  const research = sectionContentFrom(project.market_research);

  const instructions = `Sei un copywriter direct response e stratega ecommerce di alto livello.
Data la ricerca di mercato e le info prodotto, genera un PRODUCT RESEARCH BRIEF completo seguendo il framework "Ecom Domination".
${marketDirective(input)}
Usa markdown con intestazioni in grassetto.

Struttura richiesta:
**TARGET MARKET** — chi è il buyer ideale (demografia, psicografia, pain, lifestyle)
**PRODOTTO (Nome, Cosa fa, Meccanismo di delivery)**
**MECCANISMO UNICO DEL PROBLEMA**
**MECCANISMO UNICO DELLA SOLUZIONE**
**CARATTERIZZAZIONI (Soprannomi)** — per problemi e per soluzioni
**HOOK (3-5 aperture ad alto impatto)**
**PROVA TESTABILE**
**METAFORE POTENTI**
**DOMANDE PARADOSSALI**
**FASCINATIONS (bullet di curiosità)**
**NARRATIVA DEL PROBLEMA** (early signs → peggioramento → crisi → punto emotivo più basso)
**MITI & ERRORI**
**UNIQUE MECHANISM PREVIEW (UMP)** (discovery, trigger, spiegazione, prova)
**SPIEGAZIONE SOLUZIONE** (3 principi)
**PROVA & VERIFICA**
**ANGOLI ADS SUGGERITI** (3-5)`;

  const userMessage = `Prodotto: ${productName}
${input.description ? `\nDescrizione fornita:\n${input.description}` : ''}

Genera il brief completo. Basati fortemente sulla RICERCA DI MERCATO fornita nel contesto.`;

  const content = await callClaude({ task: 'vsl', instructions, marketResearch: research, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Brief returned empty output');

  const { error } = await supabase.from('projects').update({ brief: content }).eq('id', projectId);
  if (error) throw new Error(`Failed to save brief: ${error.message}`);
  try {
    // Name matches the uploaded file so the backfill dedupes instead of duplicating.
    await supabase.from('projects').update({ brief_files: toSectionBlob('Chimera Protocol — Product Brief.md', content) }).eq('id', projectId);
  } catch { /* brief_files column may not exist */ }

  // Also save as a real file so it SHOWS in the "Product Brief — Frontend" tab.
  const fileSaved = await saveSectionFile(supabase, projectId, 'pb_frontend', 'Product Brief', content);

  return {
    summary: fileSaved
      ? 'Product brief generated — saved as a document in the Product Brief (Frontend) tab.'
      : 'Product brief generated and saved (file mirror failed; content is in the project).',
    output: content,
  };
}

async function runCompetitor(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const link = (input.competitorLink || '').trim();
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);
  const productName = (project.name as string) || input.product || '';
  const country = countryFromMarket(input);

  // 1) Ask Claude for the best AD-LIBRARY SEARCH KEYWORDS for this product —
  //    the terms a media buyer would type to surface LOCAL competitors on Meta,
  //    TikTok and Google. These MUST be in the target market's language, otherwise
  //    the ad libraries surface foreign (US/English) brands.
  const geo = (input.market || input.language || '').trim() || country;
  const kwInstructions = `You are a media buyer doing competitor research for the ${geo} market.
Find LOCAL competitors' ads for THIS exact product — not the whole category.

Output EXACTLY this format (no extra text):

SEARCH
<3 phrases, one per line>

INCLUDE
<8-12 short phrases that MUST appear in a relevant ad>

EXCLUDE
<8-12 off-niche traps this search often pulls>

CRITICAL RULES:
- SEARCH phrases MUST be 2-4 words (never a single word). Combine product FORM + outcome, the way a local advertiser writes copy. Examples: "caffè dimagrante", "slim coffee", "Kaffee abnehmen" — NOT "caffè", NOT "dimagrire", NOT "coffee", NOT "weight loss".
- Write SEARCH + INCLUDE in the LOCAL LANGUAGE of ${geo}. Add the English product-form phrase only if locals also advertise in English.
- INCLUDE = product form + problem + distinctive ingredients/mechanism (enough to recognize a real competitor ad).
- EXCLUDE = adjacent junk the loose libraries return (shops, machines, generic retail, other health verticals, jobs, SaaS).
- Do NOT output brand or company names.
- NEVER output generic platform/tech terms (shopify, ecommerce, dropshipping).`;
  const kwUser = `Product: ${productName}\nMarket: ${input.market || country}\n${input.description ? `Description: ${input.description}\n` : ''}${link ? `Competitor link: ${link}\n` : ''}\nGive SEARCH / INCLUDE / EXCLUDE now.`;
  const kwRaw = await callClaude({ task: 'ad', instructions: kwInstructions, brief, marketResearch: research, userMessage: kwUser, maxTokens: 500 });

  const lexicon = parseDiscoveryLexicon(kwRaw, productName);
  const searchTerms = lexicon.search;
  const includeTerms = lexicon.include;
  const excludeTerms = lexicon.exclude;

  const base = siteBaseUrl();
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  if (!token || !base) {
    return {
      summary: !token ? 'Competitor keywords generated (Apify not configured: APIFY_KEY missing).' : 'Competitor keywords generated (URL env missing).',
      output: `Search keywords:\n- ${searchTerms.join('\n- ')}\nInclude:\n- ${includeTerms.join('\n- ')}`,
    };
  }
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';

  // Build a discovery webhook URL (no brandId → ingestion creates one brand
  // per advertiser found, "divided by page").
  const webhookFor = (platform: string): string => {
    const params = new URLSearchParams({ projectId, platform });
    if (secret) params.set('secret', secret);
    if (includeTerms.length) params.set('include', encodeLexiconParam(includeTerms));
    if (excludeTerms.length) params.set('exclude', encodeLexiconParam(excludeTerms));
    return `${base}/api/apify/webhook?${params.toString()}`;
  };

  // 2) Fire the scrapes across all three networks.
  const runs: string[] = [];
  const started: Array<{ platform: string; keyword: string; runId: string }> = [];

  // Meta / Facebook — pasted library URL is a chosen competitor: keep every
  // ad (no include/exclude). Keyword searches stay filtered.
  if (link && isMetaAdLibrary(link)) {
    const params = new URLSearchParams({ projectId, platform: 'meta' });
    if (secret) params.set('secret', secret);
    const run = await startApifyAdsRun(link, 25, `${base}/api/apify/webhook?${params.toString()}`);
    if (run.ok) { started.push({ platform: 'meta', keyword: '(link)', runId: run.runId! }); }
    else runs.push(`Meta(link): ${run.error}`);
  }
  for (const kw of searchTerms) {
    const metaUrl = fbAdLibrarySearchUrl(kw, country);
    const run = await startApifyAdsRun(metaUrl, 12, webhookFor('meta'));
    if (run.ok) started.push({ platform: 'meta', keyword: kw, runId: run.runId! });
    else runs.push(`Meta(${kw}): ${run.error}`);

    const tk = await startApifyTiktokRun(kw, country, 12, webhookFor('tiktok'));
    if (tk.ok) started.push({ platform: 'tiktok', keyword: kw, runId: tk.runId! });
    else runs.push(`TikTok(${kw}): ${tk.error}`);

    const gg = await startApifyGoogleRun(kw, country, 12, webhookFor('google'));
    if (gg.ok) started.push({ platform: 'google', keyword: kw, runId: gg.runId! });
    else runs.push(`Google(${kw}): ${gg.error}`);
  }

  const byPlatform = (p: string) => started.filter((s) => s.platform === p).length;
  const summary =
    started.length > 0
      ? `Competitor discovery started on ${started.length} run(s): Meta ${byPlatform('meta')}, TikTok ${byPlatform('tiktok')}, Google ${byPlatform('google')}. Advertisers, creatives (video/image) and their real landing pages will appear shortly in the Competitor Library.`
      : `Competitor research: no runs started. ${runs.join(' | ')}`;

  const output = [
    `Search keywords: ${searchTerms.join(', ')}`,
    includeTerms.length ? `Keep ads mentioning: ${includeTerms.join(', ')}` : '',
    excludeTerms.length ? `Drop off-niche: ${excludeTerms.slice(0, 8).join(', ')}` : '',
    started.length ? `\nStarted runs:\n${started.map((s) => `- ${s.platform} · "${s.keyword}" · run ${s.runId}`).join('\n')}` : '',
    runs.length ? `\nErrors:\n${runs.map((r) => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  return { summary, output };
}

/** Market/geography string used to localize AD COPY into the local language. */
function marketGeo(input: PipelineInput): string {
  return (input.market || input.language || '').trim();
}

// ---------------------------------------------------------------------------
// STEP 4 — Angle strategy (prioritized Angle Matrix, English strategy doc)
// ---------------------------------------------------------------------------

async function runAngle(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);
  const swipe = await loadCompetitorSwipe(supabase, projectId);

  const instructions = `You are a world-class direct-response strategist (Stefan Georgi / Todd Brown level). Build a prioritized ANGLE MATRIX: the master list of marketing angles the team will test for this product — grounded in the research, the brief, and the REAL competitor ads already running in this market.
${marketDirective(input)}

Apply the knowledge base BY NAME: Schwartz (5 Awareness Levels + 5 Sophistication Stages), Georgi Big Idea & Unique Mechanism, Todd Brown "one big marketing idea", Breakthrough Advertising sophistication plays (new claim → mechanism → amplified claim → identification), Evaldo core-emotion logic, Bencivenga proof.

Produce 6-8 DISTINCT angles, ORDERED best-first (ANGLE 1 = highest expected win rate). Use EXACTLY this markdown format, one block per angle:

## ANGLE 1 — <short, memorable angle name>
- **Awareness level:** <1-5 + label> — <why this level>
- **Sophistication move:** <new claim | mechanism | amplified claim | identification> — <why it fits this stage>
- **Core emotion:** <dominant emotion> — away-from: <pain> / toward: <desire>
- **Big idea / promise:** <one sentence that makes this angle feel NEW>
- **Unique mechanism leaned on:** <named problem/solution mechanism from the research>
- **Proof required:** <what makes it believable>
- **Competitor gap it exploits:** <what the running competitor ads FAIL to say — cite the swipe>
- **Sample hook:** "<a scroll-stopping opening line>"

Rules:
- Angles must be genuinely different from one another (not 8 rewrites of one idea).
- Ground "competitor gap" in the REAL competitor ads provided; if none are provided, infer from the research teardown and label it "(inference)".
- Be specific to THIS product/market — no generic filler.
- Write the whole document in ENGLISH (this is a strategy doc for the team; localization happens at ad production).`;

  const userMessage = `Product: ${productName}
${input.description ? `\nDescription:\n${input.description}` : ''}

${swipe
    ? `# REAL COMPETITOR ADS RUNNING IN THIS MARKET (swipe — winners first)\n\n${swipe}`
    : 'No competitor ads were scraped — infer competitor gaps from the market research competitor teardown.'}

Build the prioritized Angle Matrix now, best angle first.`;

  const content = await callClaude({ task: 'ad', instructions, brief, marketResearch: research, userMessage, maxTokens: 6000 });
  if (!content) throw new Error('Angle step returned empty output');

  const angles = parseAngles(content);

  // Persist for machine consumption (the ads step reads it back) + a downloadable doc.
  const fileSaved = await saveSectionFile(supabase, projectId, 'angles', 'Angle Matrix', content);

  // Human-visible artifact in the Funnel tab.
  try {
    await createFunnelStep(supabase, projectId, {
      stepNumber: 80,
      pageName: 'Angle Matrix (Chimera Protocol)',
      stepType: 'angle',
      resultContent: angleMatrixToHtml(content, angles),
    });
  } catch { /* non-fatal */ }

  return {
    summary: `${angles.length || 6} angles prioritized (Angle Matrix)${fileSaved ? ' — saved as a document + visible in the Funnel tab.' : ' — visible in the Funnel tab.'}`,
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 5 — Ads (top 3 angles × Meta / TikTok / Google, in the market language)
// ---------------------------------------------------------------------------

async function runAds(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const productName = (project.name as string) || input.product || '';
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);
  const swipe = await loadCompetitorSwipe(supabase, projectId);
  const angleDoc = await loadSectionFileText(supabase, projectId, 'angles');

  const geo = marketGeo(input);
  const langLine = geo
    ? `Write ALL AD COPY in the LOCAL LANGUAGE actually spoken by consumers in ${geo} (e.g. German for a German market). These are production assets shown to real buyers — NOT English, unless ${geo} is English-speaking. Keep the section LABELS (META/TIKTOK/GOOGLE, HEADLINE, etc.) in English.`
    : `Write the ad copy in the market's local language (infer it from the product/market). Keep the section LABELS in English.`;

  const instructions = `You are an elite direct-response copywriter producing PLATFORM-READY ads.
Take the TOP 3 angles from the ANGLE MATRIX provided (angles are already ordered best-first — use ANGLE 1, 2 and 3). For EACH of those 3 angles write ONE ad for EACH platform: Meta, TikTok (UGC), Google. That is 3 angles × 3 platforms = 9 ads.
${langLine}
Model what WORKS in the real competitor ads (the swipe) — the emotional register and hook patterns validated in this market — but do NOT copy them: express OUR angle and OUR unique mechanism.

Use EXACTLY this format. Separate the 3 angle blocks with a line containing only "---":

## ANGLE 1 — <the angle name from the matrix>

[META]
PRIMARY TEXT: <3-6 lines, hook-first, scroll-stopping: benefit + mechanism + proof + soft CTA>
HEADLINE: <max ~40 chars>
DESCRIPTION: <max ~30 chars>

[TIKTOK]
HOOK: <the spoken first 3 seconds>
SCRIPT: <4-6 beats, native UGC / talking-to-camera; each beat on its own line>
ON-SCREEN TEXT: <short captions>
CTA: <spoken call to action>

[GOOGLE]
HEADLINES: <h1> | <h2> | <h3> | <h4> (each max ~30 chars)
DESCRIPTIONS: <d1> | <d2> (each max ~90 chars)

---
(then ANGLE 2, then ANGLE 3, same structure)

Rules:
- Ads must be specific and immediately usable — no placeholders, no "[insert benefit]".
- Respect platform norms (Meta = story/benefit; TikTok = native UGC hook + script; Google = tight keyworded headlines).
- Keep claims defensible (no unsupported medical/legal claims).`;

  const userMessage = `Product: ${productName}
${input.description ? `\nDescription:\n${input.description}` : ''}

# ANGLE MATRIX (use the top 3, best-first)

${angleDoc || '(No angle matrix found — derive the 3 strongest angles from the market research, best-first.)'}

${swipe ? `# REAL COMPETITOR ADS (swipe — model the winning register, don't copy)\n\n${swipe}` : ''}

Write the 9 platform-ready ads now.`;

  const raw = await callClaude({ task: 'ad', instructions, brief, marketResearch: research, userMessage, maxTokens: 8000 });
  if (!raw) throw new Error('Ads step returned empty output');

  const ads = parseMultiPlatformAds(raw);

  let saved = 0;
  if (ads.length > 0) {
    const rows = ads.map((a) => ({
      project_id: projectId,
      type: `${a.platform}_ad`,
      angle: a.angle.slice(0, 300),
      concept_notes: `[${a.platform.toUpperCase()}]\n${a.text}`.slice(0, 8000),
      output_status: 'ready',
    }));
    const { error } = await supabase.from('creative_outputs').insert(rows);
    if (!error) saved = rows.length;
  }

  try {
    await createFunnelStep(supabase, projectId, {
      stepNumber: 90,
      pageName: 'Ads — Meta / TikTok / Google (Chimera Protocol)',
      stepType: 'ads',
      resultContent: adsToHtml(raw, ads),
    });
  } catch { /* non-fatal */ }

  const angleCount = new Set(ads.map((a) => a.angle)).size;
  return {
    summary: `${ads.length || 9} platform-ready ads across ${angleCount || 3} angles (Meta/TikTok/Google)${saved ? ` — saved to Creative (${saved}) + visible in the Funnel tab.` : ' — visible in the Funnel tab.'}`,
    output: raw,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function angleMatrixToHtml(raw: string, angles: AngleItem[]): string {
  const cards = angles.length
    ? angles.map((a, i) => `
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:12px 0;background:#fff">
        <div style="font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:.04em">Angle ${i + 1} — ${esc(a.name)}</div>
        <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0 0;color:#111827">${esc(a.body)}</pre>
      </div>`).join('')
    : `<pre style="white-space:pre-wrap">${esc(raw)}</pre>`;
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:8px">
    <h1 style="font-size:20px;margin:0 0 4px">Angle Matrix — prioritized</h1>
    <p style="color:#6b7280;margin:0 0 12px">${angles.length || 0} angles, best-first. Feeds the ads step.</p>
    ${cards}
  </div>`;
}

const PLATFORM_STYLE: Record<AdPlatform, { label: string; color: string }> = {
  meta: { label: 'Meta / Facebook', color: '#1877f2' },
  tiktok: { label: 'TikTok / UGC', color: '#000000' },
  google: { label: 'Google', color: '#0f9d58' },
};

function adsToHtml(raw: string, ads: PlatformAd[]): string {
  if (ads.length === 0) {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:8px">
      <h1 style="font-size:20px;margin:0 0 12px">Ads — Meta / TikTok / Google</h1>
      <pre style="white-space:pre-wrap">${esc(raw)}</pre>
    </div>`;
  }
  const byAngle = new Map<string, PlatformAd[]>();
  for (const a of ads) {
    const list = byAngle.get(a.angle) || [];
    list.push(a);
    byAngle.set(a.angle, list);
  }
  const order: AdPlatform[] = ['meta', 'tiktok', 'google'];
  const sections = [...byAngle.entries()].map(([angle, list], i) => {
    const sorted = [...list].sort((x, y) => order.indexOf(x.platform) - order.indexOf(y.platform));
    const cards = sorted.map((ad) => {
      const st = PLATFORM_STYLE[ad.platform];
      return `
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:10px 0;background:#fff">
          <div style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${st.color};border-radius:999px;padding:2px 10px;letter-spacing:.03em">${esc(st.label)}</div>
          <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0 0;color:#111827">${esc(ad.text)}</pre>
        </div>`;
    }).join('');
    return `
      <div style="margin:18px 0 8px">
        <div style="font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:.04em">Angle ${i + 1} — ${esc(angle)}</div>
        ${cards}
      </div>`;
  }).join('');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:8px">
    <h1 style="font-size:20px;margin:0 0 4px">Ads — Meta / TikTok / Google</h1>
    <p style="color:#6b7280;margin:0 0 4px">${ads.length} platform-ready ads across ${byAngle.size} angles.</p>
    ${sections}
  </div>`;
}

async function runLanding(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);
  const productName = (project.name as string) || input.product || '';

  // Read the SELECTED funnel to know how many products to make (1 main + one
  // per upsell/downsell page). The number comes from the funnel, not a guess.
  const funnel = await loadFunnelProducts(supabase, input);

  const instructions = `Sei un copywriter di landing page direct response.
Scrivi la STRUTTURA + COPY completo di una landing page ad alta conversione per questo prodotto.
${marketDirective(input)}
Usa markdown con una sezione per blocco:
## Hero (headline + subheadline + CTA)
## Problema / Agitazione
## Meccanismo unico (perché fallisce il resto)
## Soluzione / Prodotto
## Come funziona (step)
## Prove & testimonianze (struttura)
## Offerta & garanzia
## FAQ
## CTA finale
Il copy deve essere pronto all'uso, coerente con brief e ricerca. Sii specifico, niente placeholder generici.`;

  const userMessage = `Prodotto: ${productName}
Scrivi la landing completa basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const content = await callClaude({ task: 'pdp', instructions, brief, marketResearch: research, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Landing returned empty output');

  const { error } = await supabase
    .from('projects')
    .update({ funnel: toSectionBlob('AI — Landing copy', content) })
    .eq('id', projectId);
  if (error) throw new Error(`Failed to save funnel: ${error.message}`);

  // Generate the PRODUCT IMAGES first (main + correlated upsells), so the
  // mockup can actually show the real generated product in its hero.
  let images: { saved: number; total: number; note: string; mainImageUrl: string | null; images: Array<{ name: string; url: string; role: string }> } =
    { saved: 0, total: 1, note: '', mainImageUrl: null, images: [] };
  try {
    images = await generateProductImages(supabase, projectId, input, funnel, research, brief, productName);
  } catch (e) { images.note = `image gen error: ${(e as Error).message}`; }

  // Make the generated product images visible as a gallery in the Funnel tab.
  if (images.images.length > 0) {
    try {
      const cards = images.images.map((im) => `
        <figure style="margin:0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#fff">
          <img src="${im.url}" alt="${esc(im.name)}" style="width:100%;height:auto;display:block" />
          <figcaption style="padding:8px 10px;font-size:12px;color:#111827"><strong>${esc(im.role)}</strong> — ${esc(im.name)}</figcaption>
        </figure>`).join('');
      const gallery = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:0 auto;padding:8px">
        <h1 style="font-size:20px;margin:0 0 4px">Product images (Chimera Protocol)</h1>
        <p style="color:#6b7280;margin:0 0 12px">${images.saved} product images${funnel ? ` for funnel "${esc(funnel.funnelName)}"` : ''}.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">${cards}</div>
      </div>`;
      await createFunnelStep(supabase, projectId, {
        stepNumber: 2,
        pageName: 'Product Images (Chimera Protocol)',
        stepType: 'assets',
        resultContent: gallery,
      });
    } catch { /* non-fatal */ }
  }

  // Build a real, visible HTML landing MOCKUP from the copy, optionally using
  // a chosen funnel template as a design reference (fetched via Jina, no
  // headless browser). Saved as a funnel step → visible/previewable in the
  // Funnel tab.
  // Design reference for the landing mockup. One funnel now drives everything:
  // if no explicit templateUrl was passed, imitate the SELECTED funnel's main
  // page — via its URL (fetched through Jina) or, offline, its saved HTML.
  let templateRef = await fetchTemplateReference((input.templateUrl || '').trim());
  if (!templateRef && funnel) {
    if (funnel.templateUrl) templateRef = await fetchTemplateReference(funnel.templateUrl);
    if (!templateRef && funnel.templateHtml) templateRef = funnel.templateHtml.slice(0, 12_000);
  }
  let mockupSaved = false;
  try {
    const mockupInstructions = `Sei un web designer + copywriter direct response.
Genera UNA landing page COMPLETA in HTML STANDALONE (un solo file), pronta da aprire nel browser.
${marketDirective(input)}
Requisiti tecnici:
- HTML5 completo con <style> inline nel <head> (nessuna risorsa esterna, nessun JS necessario).
- Design moderno, mobile-first, responsive, con sezioni: hero, problema/agitazione, meccanismo unico, soluzione, come funziona, prove/testimonianze (placeholder realistici), offerta+garanzia, FAQ, CTA finale.
- Usa il COPY fornito qui sotto (adattalo, non inventare claim medici/legali non supportati).
- Bottoni CTA ben visibili. Palette coerente col prodotto.
${images.mainImageUrl ? `- Usa QUESTA immagine reale del prodotto nell'hero e dove serve: <img src="${images.mainImageUrl}" alt="${esc(productName)}">. Non usare altri placeholder immagine per il prodotto principale.` : ''}
${templateRef ? '- Usa lo STILE/STRUTTURA della pagina di riferimento fornita come ispirazione (layout, ordine sezioni, tono), ma con contenuti del nostro prodotto.' : ''}
Rispondi SOLO con l'HTML, senza spiegazioni e senza \`\`\`.`;

    const mockupUser = `COPY DELLA LANDING (da usare):\n\n${content}\n\n${images.mainImageUrl ? `IMMAGINE PRODOTTO PRINCIPALE (usa questo URL nell'hero): ${images.mainImageUrl}\n\n` : ''}${templateRef ? `PAGINA DI RIFERIMENTO (stile/struttura da imitare):\n\n${templateRef}` : ''}`;
    let mockup = await callClaude({ task: 'pdp', instructions: mockupInstructions, userMessage: mockupUser, maxTokens: 8000 });
    mockup = mockup.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();
    if (mockup.toLowerCase().includes('<html') || mockup.toLowerCase().includes('<!doctype')) {
      await createFunnelStep(supabase, projectId, {
        stepNumber: 1,
        pageName: 'Landing (Chimera Protocol)',
        stepType: 'landing',
        resultContent: mockup,
      });
      mockupSaved = true;
    }
  } catch { /* non-fatal: copy is already saved */ }

  const funnelNote = funnel
    ? `Funnel "${funnel.funnelName}" → ${funnel.total} products (1 main + ${funnel.upsells} upsells). `
    : 'No funnel selected → main product only. ';
  const imgNote = images.note || (images.saved ? `${images.saved}/${images.total} product images generated.` : '');

  return {
    summary: `${funnelNote}${imgNote}${mockupSaved ? 'HTML mockup visible in the Funnel tab.' : 'Landing copy saved to the Funnel section.'}`.trim(),
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 7 — Funnel swipe: load every step of the SELECTED funnel into the
// Clone/Swipe section (funnel_pages) and hand off the heavy work (text rewrite
// + GPT Image 2 image regeneration + product-mockup swap) to a dedicated
// background function with its own 15-minute budget.
// ---------------------------------------------------------------------------

/** Map an archived step's page/step type onto a funnel_pages-valid page_type
 *  (mirrors sanitizePageTypeForDb's whitelist). */
function swipePageType(raw: string): string {
  const t = raw.toLowerCase();
  if (/checkout/.test(t)) return 'checkout';
  if (/quiz/.test(t)) return 'quiz_funnel';
  if (/listicle/.test(t)) return '5_reasons_listicle';
  if (/advertorial|article|blog|review|content/.test(t)) return 'advertorial';
  if (/product/.test(t)) return 'product_page';
  if (/landing|sales|vsl|presell|opt|lead|squeeze|bridge|webinar/.test(t)) return 'landing';
  return 'altro';
}

/** Latest generated MAIN product image (the mockup from the landing step) —
 *  used by the swipe worker wherever the competitor page shows THEIR product. */
async function loadMainProductImageUrl(supabase: SupabaseClient, projectId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return null;
    // saveProductImage labels the main as "… Product — …" and upsells as
    // "… Upsell N — …": prefer the newest non-upsell image.
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    const { data: pub } = supabase.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(main.file_path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}

const MAX_SWIPE_STEPS = 8;

async function runSwipe(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  if (!input.funnelId && !(input.funnelSteps && input.funnelSteps.length)) {
    return { summary: 'No funnel selected in the launcher — Clone/Swipe step skipped.', output: '' };
  }
  if (input.funnelId && input.funnelSteps && input.funnelSteps.length === 0) {
    return { summary: 'No funnel steps selected — Clone/Swipe step skipped.', output: '' };
  }

  let dbSteps: Array<Record<string, unknown>> = [];
  let funnelName = 'Funnel';
  if (input.funnelId) {
    const { data: funnelRow, error: fErr } = await supabase
      .from('archived_funnels')
      .select('id, name, steps')
      .eq('id', input.funnelId)
      .single();
    if (fErr || !funnelRow) {
      if (!input.funnelSteps?.length) throw new Error(`Selected funnel not found: ${fErr?.message || input.funnelId}`);
    } else {
      funnelName = String(funnelRow.name || 'Funnel');
      dbSteps = Array.isArray(funnelRow.steps) ? (funnelRow.steps as Array<Record<string, unknown>>) : [];
    }
  }
  const steps = selectedArchiveSteps(input, dbSteps);
  if (!steps.length) throw new Error('Selected funnel has no steps to swipe');
  const mainImageUrl = await loadMainProductImageUrl(supabase, projectId);

  // One Clone/Swipe page per funnel step, in order. The worker fills
  // cloned/swiped HTML afterwards; status starts as in_progress so the UI
  // shows the swipe as running as soon as the pages appear.
  const pages: Array<{ funnelPageId: string; sourcePageId: string; sourceUrl: string; name: string; type: string }> = [];
  const usable = steps.slice(0, MAX_SWIPE_STEPS);
  for (let i = 0; i < usable.length; i++) {
    const s = usable[i] || {};
    const rawType = String(s.page_type || s.step_type || 'landing');
    const pageType = swipePageType(rawType);
    const url = String(s.url_to_swipe || s.url || '');
    const cloned = (s.cloned_data && typeof s.cloned_data === 'object' ? s.cloned_data : {}) as Record<string, unknown>;
    const sourcePageId = String(s.page_id || ''); // page_html key written by the extension's funnel walk
    const stepName = String(s.name || '').slice(0, 60);
    const name = `${funnelName} — Step ${i + 1}${stepName ? `: ${stepName}` : ''}`.slice(0, 120);

    const { data: created, error } = await supabase
      .from('funnel_pages')
      .insert({
        name,
        page_type: pageType,
        project_id: projectId,
        product_id: null,
        url_to_swipe: url,
        prompt: '',
        swipe_status: 'in_progress',
        cloned_data: typeof cloned.htmlUrl === 'string' && cloned.htmlUrl
          ? { htmlUrl: cloned.htmlUrl, title: name, htmlSkipped: true, source_url: url }
          : null,
      })
      .select('id')
      .single();
    if (error || !created) {
      console.warn('[pipeline] swipe page insert failed:', error?.message);
      continue;
    }
    pages.push({ funnelPageId: created.id as string, sourcePageId, sourceUrl: url, name, type: pageType });
  }
  if (!pages.length) throw new Error('Could not create any Clone/Swipe pages for the funnel');

  // Hand off to the dedicated background worker (own 15-min budget). It
  // answers 202 immediately, so a short timeout is enough to enqueue it.
  const base = siteBaseUrl();
  if (!base) throw new Error('Site base URL missing — cannot start the swipe worker');
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  try {
    await fetch(`${base}/.netlify/functions/pipeline-swipe-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, secret, market: marketGeo(input), mainImageUrl, pages }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    // Background functions ACK with 202 before running; a timeout here does
    // not necessarily mean the worker was not queued. Log and continue.
    console.warn('[pipeline] swipe worker trigger:', (e as Error).message);
  }

  return {
    summary: `${pages.length} funnel steps loaded into Clone/Swipe — text + image swipe running in background${mainImageUrl ? ' (product shots use the generated mockup)' : ''}.`,
    output: pages.map((p, i) => `${i + 1}. ${p.name}${p.sourceUrl ? ` — ${p.sourceUrl}` : ''}`).join('\n'),
  };
}

const RUNNERS: Record<StepKey, (s: SupabaseClient, p: string, i: PipelineInput) => Promise<StepResult>> = {
  market_research: runMarketResearch,
  brief: runBrief,
  competitor: runCompetitor,
  angle: runAngle,
  ads: runAds,
  landing: runLanding,
  swipe: runSwipe,
};

// ---------------------------------------------------------------------------
// Main sequencer
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  let jobId = '';
  try { jobId = String((await req.json())?.jobId || ''); } catch { /* ignore */ }
  if (!jobId) return new Response('missing jobId', { status: 200 });

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log(`[pipeline ${jobId}]`, ...a);

  const { data: job, error } = await supabase
    .from('pipeline_jobs')
    .select('id, project_id, input, status, steps')
    .eq('id', jobId)
    .single();
  if (error || !job) { log('job not found:', error?.message); return new Response('job not found', { status: 200 }); }
  if (!job.project_id) { log('job has no project_id'); return new Response('no project', { status: 200 }); }

  const projectId = job.project_id as string;
  const input = (job.input || {}) as PipelineInput;
  const steps: StepState[] = Array.isArray(job.steps) ? (job.steps as StepState[]) : [];
  const orderedKeys: string[] = steps.length > 0 ? steps.map((s) => s.key) : [...STEP_ORDER];

  const persistSteps = async (patch: Record<string, unknown> = {}) => {
    await supabase.from('pipeline_jobs').update({ steps, ...patch }).eq('id', jobId);
  };

  for (const key of orderedKeys) {
    // Cancellation check.
    const { data: fresh } = await supabase.from('pipeline_jobs').select('status').eq('id', jobId).single();
    if (fresh?.status === 'canceled') { log('canceled — stopping'); return new Response('canceled', { status: 200 }); }

    const idx = steps.findIndex((s) => s.key === key);
    if (idx === -1) continue;
    const cur = steps[idx];
    if (cur.status === 'completed' || cur.status === 'skipped') continue;

    const runner = RUNNERS[key as StepKey];
    if (!runner) continue;

    log('running step', key);
    steps[idx] = { ...cur, status: 'running', startedAt: new Date().toISOString(), error: undefined };
    await persistSteps({ status: 'running', current_step: key, error: null });

    try {
      const result = await runner(supabase, projectId, input);
      steps[idx] = {
        ...steps[idx],
        status: 'completed',
        summary: result.summary,
        output: (result.output || '').slice(0, STEP_OUTPUT_PREVIEW_CHARS),
        finishedAt: new Date().toISOString(),
        error: undefined,
      };
      const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
      await persistSteps({ status: allDone ? 'completed' : 'running', current_step: allDone ? null : key });
      log('step', key, '→ completed');
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 1000) || 'Errore step';
      steps[idx] = { ...steps[idx], status: 'failed', error: msg, finishedAt: new Date().toISOString() };
      await persistSteps({ status: 'failed', current_step: key, error: `Step ${key}: ${msg}`.slice(0, 1000) });
      log('step', key, '→ failed:', msg);
      return new Response('failed', { status: 200 });
    }
  }

  log('done');
  return new Response('done', { status: 200 });
};
