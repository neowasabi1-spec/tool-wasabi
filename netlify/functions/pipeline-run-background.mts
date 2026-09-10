import { createClient } from '@supabase/supabase-js';
import { getCoreKnowledge, getKnowledgeForTask } from '../../src/knowledge/copywriting';
import { fold, parseDiscoveryLexicon, parseTermList } from '../../src/lib/competitor-relevance';
import { loadDiscoveryLexicon, saveDiscoveryLexicon, shortApifyWebhookUrl } from '../../src/lib/discovery-lexicon';
import { parseSectionData } from '../../src/lib/project-sections';
import { extractLandingMediaFromUrl, listLandingMedia, offerIdentityFromHtml } from '../../src/lib/landing-media';
import { fetchPageText, pageTextBlock } from '../../src/lib/page-text';
import { wellFormed } from '../../src/lib/well-formed';
import { openaiGenerateImage, openaiImageKey } from '../../src/lib/openai-image';

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
/** If Facebook research / ads fail, still build mockups + Clone/Swipe. */
const OPTIONAL_STEPS = new Set<StepKey>(['competitor', 'angle', 'ads']);

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
  imageMode?: 'affiliate' | 'internal';
  productImageUrl?: string;
  price?: string;
  productPrices?: Array<{ role: 'main' | 'upsell'; pageType?: string; stepName?: string; price: string }>;
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

  const tier1 = wellFormed([opts.instructions.trim(), core].filter(Boolean).join('\n\n---\n\n'));
  system.push({ type: 'text', text: tier1, cache_control: { type: 'ephemeral' } });
  if (tier2) system.push({ type: 'text', text: wellFormed(tier2), cache_control: { type: 'ephemeral' } });

  // User message with brief + research prefixed.
  const sections: string[] = [];
  if (opts.brief?.trim()) sections.push('# PRODUCT BRIEF', '', opts.brief.trim());
  if (opts.marketResearch?.trim()) sections.push('# MARKET RESEARCH', '', opts.marketResearch.trim());
  sections.push('# REQUEST', '', opts.userMessage);
  const userContent = wellFormed(sections.join('\n\n'));

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
// Image generation via ChatGPT (OpenAI Images API, gpt-image-2).
// text2image for the main product, image2image (edit) for upsells so they
// share the brand look. Requires OPENAI_API_KEY.
// ---------------------------------------------------------------------------

interface GenImage { data: Buffer; mimeType: string; }

async function generateImageUrl(
  kind: 't2i' | 'i2i',
  input: Record<string, unknown>,
  timeoutMs = 240_000,
): Promise<string | null> {
  const urls = Array.isArray(input.image_urls) ? (input.image_urls as string[]) : [];
  return openaiGenerateImage({
    prompt: String(input.prompt || ''),
    imageUrls: kind === 'i2i' || urls.length ? urls : undefined,
    size: String(input.image_size || '1024x1024'),
    quality: String(input.quality || 'medium'),
    timeoutMs,
  });
}

/** Download a generated image URL (or data URL) into a Buffer for storage. */
async function downloadImage(url: string): Promise<GenImage | null> {
  try {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 100) return null;
      return { data: buf, mimeType: m[1] || 'image/png' };
    }
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
  const n = Math.min(Math.max(count || 20, 1), 1000);
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
  const n = Math.min(Math.max(count || 20, 1), 1000);
  const region = (country || '').trim().replace(/^ALL$/i, '') || 'all';
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
  const n = Math.min(Math.max(count || 20, 1), 1000);
  const reg = (region || '').trim().replace(/^ALL$/i, '') || 'anywhere';
  const input: Record<string, unknown> = {
    queries: [keyword], searchQuery: keyword, searchTargets: [keyword],
    region: reg, regions: [reg], dateRangePreset: 'LAST_30_DAYS',
    adFormat: 'ALL', enrichLandingPages: true, scrapeDetails: true,
    maxResults: n, maxAdsPerTarget: n, maxAdvertisersPerKeyword: 40,
  };
  return startApifyRun(actor, input, webhookUrl);
}

function siteBaseUrl(): string {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '');
}

/**
 * The link the user gave (offer page in affiliate mode, reference competitor
 * otherwise) as readable text + a prompt block. The model cannot browse: if we
 * only pass the URL it writes "I could not retrieve the page" and invents the
 * product (name, mechanism, ingredients). Every doc step must get the real text.
 */
/**
 * The offer link is not mandatory in the launcher: when it is missing, reuse
 * the one Chimera already researched for this project (saved in the discovery
 * lexicon by a previous affiliate run) instead of working blind.
 */
async function resolveOfferLink(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<string> {
  const given = (input.competitorLink || '').trim();
  if (/^https?:\/\//i.test(given)) return given;
  if (input.imageMode !== 'affiliate') return given;
  const stored = await loadDiscoveryLexicon(supabase, projectId).catch(() => null);
  const url = stored?.product?.offerUrl || '';
  if (url) console.log(`[pipeline] no offer link given — reusing the project's stored offer ${url}`);
  return url;
}

/**
 * Everything the USER put on the project (description, uploaded brief /
 * research files) — never Chimera's own previous output, which would feed the
 * model its own guesses. Uploaded materials are facts; they go in every doc.
 */
function userSources(project: Record<string, unknown>): string {
  const parts: string[] = [];
  const desc = String(project.description || '').trim();
  if (desc) parts.push(`PROJECT DESCRIPTION (written by the team):\n${desc}`);
  const ours = /^(Chimera Protocol|Autopilot)\b/i;
  for (const [label, val] of [['UPLOADED BRIEF FILE', project.brief_files], ['UPLOADED BRIEF FILE', project.brief], ['UPLOADED RESEARCH FILE', project.market_research]] as Array<[string, unknown]>) {
    const files = parseSectionData(val).files.filter((f) => f.content?.trim() && !ours.test(f.name || ''));
    for (const f of files) parts.push(`${label} "${f.name}":\n${f.content.trim().slice(0, 40_000)}`);
    if (label === 'UPLOADED BRIEF FILE' && typeof val === 'string' && val.trim() && !val.trim().startsWith('{') && !/^# PRODUCT RESEARCH BRIEF/.test(val.trim())) {
      parts.push(`PROJECT BRIEF TEXT:\n${val.trim().slice(0, 40_000)}`);
    }
  }
  return parts.join('\n\n');
}

/** Hard rule shared by research + brief: facts come from sources, period. */
const NO_INVENTION_RULE = `PRODUCT FACTS — NON-NEGOTIABLE:
- Product facts (exact name, format, ingredients/components, mechanism, dosage/usage, price, guarantee, certifications, spokesperson credentials, studies) may ONLY come from the sources provided (offer page text, uploaded files, description).
- If a fact is not in the sources, write "(unknown — not in sources)" and keep that part of the copy at category level. NEVER present an ingredient list, a percentage, a study or a named technology as if it were real.
- A memorable NAME for a mechanism is allowed only as copy (label it "(coined)") and must not imply ingredients or science that are not in the sources.
- Marked inferences about the MARKET (audience, competitors, prices in the category) are fine; inventions about OUR PRODUCT are not.`;

async function linkContext(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<{ block: string; note: string }> {
  const raw = await resolveOfferLink(supabase, projectId, input);
  if (!/^https?:\/\//i.test(raw)) return { block: '', note: '' };
  const affiliate = input.imageMode === 'affiliate';
  const page = await fetchPageText(raw, { max: 30_000 });
  if (!page.text) {
    return {
      block: affiliate
        ? `Offer page we promote: ${cleanOfferUrl(raw)} (page text could not be fetched — state clearly which product facts are unknown; do NOT invent a product name, ingredients or mechanism).`
        : `Reference competitor link: ${raw} (page text could not be fetched).`,
      note: 'page text unavailable',
    };
  }
  const block = affiliate
    ? pageTextBlock('OFFER PAGE WE PROMOTE (this IS our product — its real name, ingredients, mechanism, dosage, price, guarantee and claims are below)', page)
    : pageTextBlock('REFERENCE COMPETITOR PAGE', page);
  return { block, note: `${page.text.length}c via ${page.via}` };
}

/** Funnel Builder is only for real Clone/Swipe steps — never Chimera docs. */
async function clearChimeraFunnelJunk(supabase: SupabaseClient, projectId: string): Promise<void> {
  await supabase.from('funnel_steps').delete().eq('project_id', projectId).eq('flow_name', 'Chimera Protocol');
  await supabase.from('funnel_steps').delete().eq('project_id', projectId).ilike('page_name', '%Chimera Protocol%');
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
 *  `project_files` row (file_type product_image, plus optional Product Brief
 *  mockup types so the tab actually shows the packshot). Returns the public URL. */
async function saveProductImage(
  supabase: SupabaseClient,
  projectId: string,
  label: string,
  img: GenImage,
  extraTypes: string[] = [],
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
    const types = ['product_image', ...extraTypes.filter(Boolean)];
    for (const file_type of types) {
      const { error: insErr } = await supabase.from('project_files').insert({
        project_id: projectId,
        file_type,
        file_path: objectKey,
        original_name: `${safe}.${ext}`,
      });
      if (insErr) {
        console.warn('[pipeline] product_files insert failed:', file_type, insErr.message);
        if (file_type === 'product_image') {
          await supabase.storage.from(PROJECT_FILES_BUCKET).remove([objectKey]).catch(() => {});
          return null;
        }
      }
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

/** Keep the funnel step's real type (upsell_1, downsell, checkout, …).
 *  Local helper — do not import src/types (Netlify functions cannot resolve `@/`). */
function swipePageType(raw: string): string {
  const t = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!t) return 'landing';
  const numbered = t.match(/^(upsell|downsell)_?(\d+)$/);
  if (numbered) return `${numbered[1]}_${numbered[2]}`;
  if (t === 'upsell' || t === 'oto' || t === 'oto_1') return 'upsell_1';
  if (t === 'oto_2') return 'upsell_2';
  if (t === 'oto_3') return 'upsell_3';
  if (/downsell/.test(t)) return 'downsell';
  if (/checkout/.test(t)) return 'checkout';
  if (/quiz/.test(t)) return 'quiz_funnel';
  if (/listicle/.test(t)) return '5_reasons_listicle';
  if (/advertorial|article|blog|review/.test(t)) return 'advertorial';
  if (/bridge/.test(t)) return 'bridge_page';
  if (/\bvsl\b/.test(t)) return 'vsl';
  if (/landing|sales|presell|opt|lead|squeeze|webinar/.test(t)) return 'landing';
  return t;
}

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

  if (!openaiImageKey()) {
    return { saved: 0, total: 1 + upsellCount, note: 'image generation skipped: OPENAI_API_KEY not configured.', mainImageUrl: null, images };
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
  let mainRefUrl: string | null = null;

  const mainUrl = await generateImageUrl('t2i', {
    prompt: buildPackshotPrompt(spec.main.imagePrompt),
    image_size: 'square_hd',
    quality: 'medium',
  });
  if (mainUrl) {
    mainRefUrl = mainUrl;
    const dl = await downloadImage(mainUrl);
    if (dl) {
      const stored = await saveProductImage(supabase, projectId, `Product — ${spec.main.name}`, dl, ['img_pb_frontend']);
      if (stored) { mainImageUrl = stored; mainRefUrl = stored; saved++; images.push({ name: spec.main.name, url: stored, role: 'Main product' }); }
    }
  }

  let upIdx = 0;
  for (const up of spec.upsells) {
    upIdx++;
    const prompt = `${buildPackshotPrompt(up.imagePrompt)} It belongs to the SAME product family/brand as the reference image — keep the same palette, packaging style and branding.`;
    const upUrl = mainRefUrl
      ? await generateImageUrl('i2i', {
          prompt,
          image_urls: [mainRefUrl],
          image_size: 'auto',
          quality: 'medium',
        })
      : await generateImageUrl('t2i', {
          prompt,
          image_size: 'square_hd',
          quality: 'medium',
        });
    if (upUrl) {
      const dl = await downloadImage(upUrl);
      const stored = dl ? await saveProductImage(
        supabase,
        projectId,
        `Upsell ${upIdx} — ${up.name}`,
        dl,
        [`img_pb_${swipePageType((funnel?.pages || []).filter((p) => UPSELL_PAGE_RE.test(p.type))[upIdx - 1]?.type || `upsell_${upIdx}`)}`],
      ) : null;
      const finalUrl = stored || upUrl;
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
    .select('id, name, description, domain, market_research, brief, brief_files, front_end, funnel, owner_user_id')
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

${NO_INVENTION_RULE}
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

  const link = await linkContext(supabase, projectId, input);
  const affiliate = input.imageMode === 'affiliate';
  const sources = userSources(project);
  const userMessage = `Product: ${productName}
${input.description ? `\nProvided description:\n${input.description}` : ''}
${sources ? `\n${sources}\n` : ''}
${link.block ? `\n${link.block}\n` : ''}
${!link.block && !sources && !input.description ? `\nNO SOURCES about the product were provided (no offer page, no uploaded files, no description). Research the MARKET around "${productName}" thoroughly, but keep every product-specific section at category level and mark unknown facts "(unknown — not in sources)". Do not invent what the product contains or how it works.\n` : ''}
${affiliate && link.block ? `\nAFFILIATE OFFER: we sell EXACTLY the product on the offer page above. Its name, format, ingredients, mechanism, dosage, price, guarantee and compliance wording are FACTS to use verbatim — do not rename the product, do not invent ingredients or a different mechanism. Build the research around this real product; competitors are OTHER brands selling the same kind of product.\n` : ''}
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

  const grounded = link.note && link.note !== 'page text unavailable' ? ` Grounded on the ${affiliate ? 'offer' : 'reference'} page text (${link.note}).` : link.note ? ' WARNING: the link page text could not be fetched.' : '';
  return {
    summary: (fileSaved
      ? 'RMBC market research generated — saved as a document in the Market Research section.'
      : 'RMBC market research generated and saved (file mirror failed; content is in the project).') + grounded,
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
**ANGOLI ADS SUGGERITI** (3-5)

${NO_INVENTION_RULE}
La RICERCA DI MERCATO nel contesto può contenere parti marcate "(inference)" o "(unknown — not in sources)": non trasformarle in fatti.`;

  const link = await linkContext(supabase, projectId, input);
  const affiliate = input.imageMode === 'affiliate';
  const sources = userSources(project);
  const userMessage = `Prodotto: ${productName}
${input.description ? `\nDescrizione fornita:\n${input.description}` : ''}
${sources ? `\n${sources}\n` : ''}
${link.block ? `\n${link.block}\n` : ''}
${affiliate && link.block ? `\nOFFERTA IN AFFILIAZIONE: il prodotto è ESATTAMENTE quello della pagina offerta qui sopra. Nome, formato, ingredienti, meccanismo, dosaggio, prezzo, garanzia e claim sono FATTI da riprendere così come sono — non rinominare il prodotto, non inventare ingredienti o un meccanismo diverso.\n` : ''}
Genera il brief completo. Basati fortemente sulla RICERCA DI MERCATO fornita nel contesto${link.block ? ' e sul testo della pagina' : ''}.`;

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

/** Offer links carry click ids: show/store the page, not the tracker noise. */
function cleanOfferUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * Affiliate runs: the funnel must show the promoted offer's own photos. Pull
 * them from the offer link into the project library before anything else.
 */
type OfferInfo = { note: string; names: string[]; hosts: string[]; blurb: string };

async function loadOfferMedia(
  supabase: SupabaseClient,
  projectId: string,
  link: string,
): Promise<OfferInfo> {
  const none: OfferInfo = { note: 'No offer link — photos come from the landings saved on this project.', names: [], hosts: [], blurb: '' };
  if (!link) return none;
  try {
    const before = (await listLandingMedia(supabase, projectId)).filter((m) => m.storedUrl).length;
    const r = await extractLandingMediaFromUrl(supabase, { projectId, url: link, limit: 40 });
    const after = (await listLandingMedia(supabase, projectId)).filter((m) => m.storedUrl).length;
    const id = offerIdentityFromHtml(r.html, [link, r.finalUrl]);
    return {
      note: `Offer page ${cleanOfferUrl(r.finalUrl)}: ${r.found} media found, ${r.saved} new saved (library now ${after} files${before ? `, was ${before}` : ''}).`,
      ...id,
    };
  } catch (e) {
    return { ...none, note: `Offer page media: ${(e as Error).message}` };
  }
}

/** Affiliate: the search is the PRODUCT itself — its names, not its category. */
function affiliateSearchTerms(claudeTerms: string[], offer: OfferInfo, productName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (s.length < 3 || s.length > 60) return;
    const key = fold(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  push(productName);
  for (const t of claudeTerms) push(t);
  for (const n of offer.names) push(n);
  // Domain names show up in ad link text; a cheap extra net for other affiliates.
  for (const h of offer.hosts) push(h);
  return out.slice(0, 12);
}

async function runCompetitor(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const link = await resolveOfferLink(supabase, projectId, input);
  const affiliate = input.imageMode === 'affiliate';
  const offer: OfferInfo = affiliate
    ? await loadOfferMedia(supabase, projectId, link)
    : { note: '', names: [], hosts: [], blurb: '' };
  const offerNote = offer.note;
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);
  const productName = (project.name as string) || input.product || '';
  // Affiliate: the product name is the filter, so search the ad libraries
  // WORLDWIDE — the brand and its affiliates run wherever the offer converts,
  // and a guessed country (default IT) simply returns "Ads not found".
  const marketGiven = (input.market || input.language || '').trim();
  const country = affiliate ? 'ALL' : countryFromMarket(input);

  // 1) Ask Claude for the best AD-LIBRARY SEARCH KEYWORDS for this product —
  //    the terms a media buyer would type to surface LOCAL competitors on Meta,
  //    TikTok and Google. These MUST be in the target market's language, otherwise
  //    the ad libraries surface foreign (US/English) brands.
  const geo = marketGiven || (affiliate ? 'the offer page’s own market (its language tells you which)' : country);
  // Cast a WIDE net here: every phrase a buyer or an affiliate would use for
  // this kind of product. Relevance is decided afterwards by the model reading
  // each advertiser's ads (competitor-judge), not by these words.
  const kwInstructions = affiliate
    ? `You are an AFFILIATE media buyer. We promote an existing offer (OUR PRODUCT below) and want EVERY advertiser running THIS EXACT product on Meta / TikTok / Google — the brand itself and the other affiliates — to study their ads. Ad libraries search the ad text, so the searches are the strings an ad for this product would contain.

Output EXACTLY this format (no extra text):

SEARCH
<8-12 strings, one per line>

INCLUDE
<the same names, one per line>

EXCLUDE
<leave empty>

CRITICAL RULES:
- First SEARCH line = the bare brand name alone (the single word buyers know it by), then the product name alone.
- SEARCH = exact product name, brand name, brand + product, spelling/spacing variants an advertiser might use ("JellyStick", "Jelly-Stick"), the offer/advertorial name from the page title, and "<product> review" / "<product> reviews" in the language of ${geo}. Do not translate the product name into other languages: names are searched as-is, worldwide.
- NEVER category phrases ("fiber supplement", "appetite jelly", "slimming coffee") — those pull OTHER products, which we do not want.
- No generic words, no competitor brands.`
    : `You are a media buyer doing competitor research for the ${geo} market.
Goal: surface EVERY advertiser selling the same kind of product as ours — all brands, formats, clones and affiliates. Missing a competitor is worse than a noisy search; irrelevant advertisers are removed later by a reader that looks at each ad.

Output EXACTLY this format (no extra text):

SEARCH
<10 phrases, one per line>

INCLUDE
<8-12 short category phrases>

EXCLUDE
<6-10 off-niche traps this search often pulls>

CRITICAL RULES:
- SEARCH phrases MUST be 2-4 words (never a single word). Cover the category from every side: product form, key ingredient/mechanism, the problem it solves, the outcome promised, how buyers nickname it, how affiliates headline it. Examples of the STYLE: "caffè dimagrante", "slim coffee", "konjac jelly", "appetite gummy" — NOT our brand, NOT a single generic word.
- 10 genuinely DIFFERENT searches — not rewrites of one phrase.
- Write in the LOCAL LANGUAGE of ${geo}; add the English phrases too when locals also see English ads.
- INCLUDE = category signals (form + problem + mechanism/ingredients). Never our brand name.
- EXCLUDE = shops, machines, generic retail, other verticals, jobs, SaaS.
- Do NOT output brand or company names.
- NEVER output generic platform/tech terms (shopify, ecommerce, dropshipping).`;
  const linkLine = link
    ? affiliate
      ? `Offer page we promote (this IS our product): ${cleanOfferUrl(link)}\n${offer.blurb ? `What the offer page says about itself:\n${offer.blurb}\n` : ''}`
      : `Competitor link: ${link}\n`
    : '';
  const kwUser = `Product: ${productName}\nMarket: ${marketGiven || (affiliate ? 'worldwide (wherever this offer is advertised)' : country)}\n${input.description ? `Description: ${input.description}\n` : ''}${linkLine}\nGive SEARCH / INCLUDE / EXCLUDE now.`;
  const kwRaw = await callClaude({ task: 'ad', instructions: kwInstructions, brief, marketResearch: research, userMessage: kwUser, maxTokens: 700 });

  let searchTerms: string[];
  let includeTerms: string[];
  let excludeTerms: string[];
  if (affiliate) {
    // Names, not categories: single-word brand names must survive here.
    const rawSearch = parseTermList(kwRaw.match(/SEARCH\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:INCLUDE|EXCLUDE)\s*:?\s*\n|$)/i)?.[1] || kwRaw);
    searchTerms = affiliateSearchTerms(rawSearch, offer, productName);
    includeTerms = searchTerms.filter((t) => !offer.hosts.includes(t));
    excludeTerms = [];
  } else {
    const lexicon = parseDiscoveryLexicon(kwRaw, productName);
    searchTerms = lexicon.search;
    includeTerms = lexicon.include;
    excludeTerms = lexicon.exclude;
  }

  const base = siteBaseUrl();
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  if (!token || !base) {
    return {
      summary: !token ? 'Competitor keywords generated (Apify not configured: APIFY_KEY missing).' : 'Competitor keywords generated (URL env missing).',
      output: `${offerNote ? `${offerNote}\n\n` : ''}Search keywords:\n- ${searchTerms.join('\n- ')}\nInclude:\n- ${includeTerms.join('\n- ')}`,
    };
  }
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  try {
    const descr = (input.description || '').trim()
      || String(project.description || '').trim()
      || brief.replace(/\s+/g, ' ').slice(0, 900);
    await saveDiscoveryLexicon(supabase, projectId, includeTerms, excludeTerms, {
      name: productName,
      description: affiliate && offer.blurb
        ? `${descr.slice(0, 500)}\n\nOFFER PAGE (${cleanOfferUrl(link)}):\n${offer.blurb}`.slice(0, 1200)
        : descr.slice(0, 900),
      market: marketGiven || (affiliate ? 'worldwide' : country),
      affiliate,
      hosts: offer.hosts,
      offerUrl: affiliate && link ? cleanOfferUrl(link) : undefined,
      names: affiliate ? [productName, ...offer.names].filter(Boolean) : undefined,
    });
  } catch (e) {
    console.warn('[pipeline] discovery lexicon:', (e as Error).message);
  }

  const webhookFor = (platform: string): string =>
    shortApifyWebhookUrl({ base, projectId, platform, secret });

  // 2) Fire the scrapes across all three networks.
  const runs: string[] = [];
  const started: Array<{ platform: string; keyword: string; runId: string }> = [];

  // Meta / Facebook — pasted library URL is a chosen competitor: keep every
  // ad (no include/exclude). Keyword searches stay filtered.
  if (link && isMetaAdLibrary(link)) {
    const run = await startApifyAdsRun(link, 25, webhookFor('meta'));
    if (run.ok) { started.push({ platform: 'meta', keyword: '(link)', runId: run.runId! }); }
    else runs.push(`Meta(link): ${run.error}`);
  }
  // DEPTH is what finds advertisers: a product with 1500 active ads spread
  // over dozens of pages/affiliates cannot be covered by 40 ads per search —
  // one page alone runs 40 variants. The exact-name searches (affiliate) go
  // deep; the webhook groups ads per advertiser and the model judge keeps
  // only the ones that actually run this product.
  const DEEP = 400;   // affiliate: brand / product-name searches
  const WIDE = 100;   // category phrases, host names, TikTok, Google
  const deepTerms = new Set(affiliate ? searchTerms.filter((t) => !offer.hosts.includes(t)).slice(0, 3) : []);
  for (const kw of searchTerms) {
    const metaCount = deepTerms.has(kw) ? DEEP : WIDE;
    const metaUrl = fbAdLibrarySearchUrl(kw, country);
    const run = await startApifyAdsRun(metaUrl, metaCount, webhookFor('meta'));
    if (run.ok) started.push({ platform: 'meta', keyword: kw, runId: run.runId! });
    else runs.push(`Meta(${kw}): ${run.error}`);

    const tk = await startApifyTiktokRun(kw, country, WIDE, webhookFor('tiktok'));
    if (tk.ok) started.push({ platform: 'tiktok', keyword: kw, runId: tk.runId! });
    else runs.push(`TikTok(${kw}): ${tk.error}`);

    const gg = await startApifyGoogleRun(kw, country, WIDE, webhookFor('google'));
    if (gg.ok) started.push({ platform: 'google', keyword: kw, runId: gg.runId! });
    else runs.push(`Google(${kw}): ${gg.error}`);
  }

  const byPlatform = (p: string) => started.filter((s) => s.platform === p).length;
  const summary =
    started.length > 0
      ? `Competitor discovery started on ${started.length} run(s): Meta ${byPlatform('meta')}, TikTok ${byPlatform('tiktok')}, Google ${byPlatform('google')}. Advertisers, creatives (video/image) and their real landing pages will appear shortly in the Competitor Library.`
      : `Competitor research: no runs started. ${runs.join(' | ')}`;

  const output = [
    offerNote,
    affiliate ? 'Affiliate: looking for everyone running THIS exact product (brand + other affiliates). Other products in the category are dropped. Competitor photos stay out of this offer’s library.' : '',
    affiliate && offer.hosts.length ? `Offer domains: ${offer.hosts.join(', ')}` : '',
    `Ad libraries searched ${country === 'ALL' ? 'worldwide (all countries)' : `in ${country}`}.`,
    `Search keywords (${searchTerms.length}): ${searchTerms.join(', ')}`,
    affiliate
      ? 'Relevance: the model keeps an advertiser only when its ad names this product (or lands on the offer domain).'
      : 'Relevance: the model reads each advertiser’s ads and keeps only real competitors of this product.',
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

  return {
    summary: `${angles.length || 6} angles prioritized (Angle Matrix)${fileSaved ? ' — saved as a document.' : '.'}`,
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

  const angleCount = new Set(ads.map((a) => a.angle)).size;
  return {
    summary: `${ads.length || 9} platform-ready ads across ${angleCount || 3} angles (Meta/TikTok/Google)${saved ? ` — saved to Creative (${saved}).` : '.'}`,
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

  // Product photo: uploaded packshot wins. Affiliate never invents a mockup.
  // Internal without a photo invents one (and upsells) as before.
  const uploadedUrl = typeof input.productImageUrl === 'string' && /^https?:\/\//i.test(input.productImageUrl)
    ? input.productImageUrl
    : null;
  const skipMockup = input.imageMode === 'affiliate';
  let images: { saved: number; total: number; note: string; mainImageUrl: string | null; images: Array<{ name: string; url: string; role: string }> } =
    { saved: 0, total: 1, note: '', mainImageUrl: uploadedUrl, images: [] };

  if (uploadedUrl) {
    images = {
      saved: 1,
      total: 1,
      note: 'Using the uploaded product photo.',
      mainImageUrl: uploadedUrl,
      images: [{ name: productName, url: uploadedUrl, role: 'Main product' }],
    };
    try { await adoptUploadedProductImage(supabase, projectId, uploadedUrl, productName); } catch { /* already on project */ }
  } else if (!skipMockup) {
    try {
      images = await generateProductImages(supabase, projectId, input, funnel, research, brief, productName);
    } catch (e) { images.note = `image gen error: ${(e as Error).message}`; }
    if (!images.saved) {
      throw new Error(
        images.note || 'Internal mode generated 0 product mockups. Check OPENAI_API_KEY and retry.',
      );
    }
  } else {
    images.note = 'Affiliate: mockup skipped — competitor landing photos are used as-is.';
  }

  const funnelNote = funnel
    ? `Funnel "${funnel.funnelName}" → ${funnel.total} products (1 main + ${funnel.upsells} upsells). `
    : 'No funnel selected → main product only. ';
  const imgNote = images.note || (images.saved ? `${images.saved}/${images.total} product images generated.` : '');
  const extra = skipMockup
    ? ' Landing copy saved. Affiliate skipped the invented mockup.'
    : uploadedUrl
      ? ' Landing copy saved. Using the uploaded product photo.'
      : ' Landing copy saved.';

  return {
    summary: `${funnelNote}${imgNote}${extra}`.trim(),
    output: content,
  };
}

// ---------------------------------------------------------------------------
// STEP 7 — Funnel swipe: load every step of the SELECTED funnel into the
// Clone/Swipe section (funnel_pages) and hand off the heavy work (text rewrite
// + GPT Image 2 image regeneration + product-mockup swap) to a dedicated
// background function with its own 15-minute budget.
// ---------------------------------------------------------------------------

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

/** If the user uploaded a packshot (possibly to chimera-uploads/), copy it
 *  onto this project as product_image so swipe + Funnel tab can find it. */
async function adoptUploadedProductImage(
  supabase: SupabaseClient,
  projectId: string,
  url: string,
  productName: string,
): Promise<void> {
  const already = await loadMainProductImageUrl(supabase, projectId);
  if (already && already === url) return;
  if (already && url.includes(`/${projectId}/product_image/`)) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return;
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    await saveProductImage(supabase, projectId, `Product — ${productName}`, {
      data: buf,
      mimeType: mime,
    });
  } catch (e) {
    console.warn('[pipeline] adopt uploaded photo:', (e as Error).message);
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
  const uploaded = typeof input.productImageUrl === 'string' && /^https?:\/\//i.test(input.productImageUrl)
    ? input.productImageUrl
    : null;
  const mainImageUrl = uploaded || await loadMainProductImageUrl(supabase, projectId);
  const { data: projOwner } = await supabase.from('projects').select('owner_user_id').eq('id', projectId).maybeSingle();
  const ownerUserId = typeof projOwner?.owner_user_id === 'string' ? projOwner.owner_user_id : null;

  // One Clone/Swipe page per funnel step, in order. The worker fills
  // cloned/swiped HTML afterwards; status starts as in_progress so the UI
  // shows the swipe as running as soon as the pages appear.
  const pages: Array<{ funnelPageId: string; sourcePageId: string; sourceUrl: string; name: string; type: string; htmlUrl?: string }> = [];
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

    const htmlUrl = typeof cloned.htmlUrl === 'string' ? cloned.htmlUrl : '';
    const { data: created, error } = await supabase
      .from('funnel_pages')
      .insert({
        name,
        page_type: pageType,
        project_id: projectId,
        product_id: projectId,
        url_to_swipe: url,
        prompt: '',
        swipe_status: 'in_progress',
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        cloned_data: htmlUrl
          ? { htmlUrl, title: name, htmlSkipped: true, source_url: url }
          : null,
      })
      .select('id')
      .single();
    if (error || !created) {
      console.warn('[pipeline] swipe page insert failed:', error?.message);
      continue;
    }
    pages.push({
      funnelPageId: created.id as string,
      sourcePageId,
      sourceUrl: url,
      name,
      type: pageType,
      htmlUrl,
    });
  }
  if (!pages.length) throw new Error('Could not create any Clone/Swipe pages for the funnel');

  try {
    const stepRows = usable.map((s, i) => {
      const rawType = String(s.page_type || s.step_type || 'landing');
      const stepName = String(s.name || `Step ${i + 1}`).slice(0, 80);
      return {
        project_id: projectId,
        step_number: i + 1,
        page_name: stepName,
        step_type: swipePageType(rawType),
        template_name: stepName,
        url: String(s.url_to_swipe || s.url || ''),
        flow_name: funnelName.slice(0, 80),
        product: String(input.product || funnelName).slice(0, 120),
        status: 'pending',
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      };
    });
    const { error: stepErr } = await supabase.from('funnel_steps').insert(stepRows);
    if (stepErr) console.warn('[pipeline] funnel_steps insert:', stepErr.message);
  } catch (e) {
    console.warn('[pipeline] funnel_steps insert threw:', (e as Error).message);
  }

  // Hand off to the dedicated background worker (own 15-min budget). It
  // answers 202 immediately, so a short timeout is enough to enqueue it.
  const base = siteBaseUrl();
  if (!base) throw new Error('Site base URL missing — cannot start the swipe worker');
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';
  const offerUrl = input.imageMode === 'affiliate' ? await resolveOfferLink(supabase, projectId, input) : '';
  try {
    await fetch(`${base}/.netlify/functions/pipeline-swipe-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        secret,
        market: marketGeo(input),
        mainImageUrl,
        imageMode: input.imageMode === 'affiliate' ? 'affiliate' : 'internal',
        offerUrl,
        pages,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    // Background functions ACK with 202 before running; a timeout here does
    // not necessarily mean the worker was not queued. Log and continue.
    console.warn('[pipeline] swipe worker trigger:', (e as Error).message);
  }

  return {
    summary: `${pages.length} funnel steps loaded into Clone/Swipe — swipe runs in photo batches (never one 15-min block)${mainImageUrl ? (uploaded ? ' · product shots use the uploaded photo' : ' · product shots use the generated mockup') : ''}.`,
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
  const priceLines = Array.isArray(input.productPrices)
    ? input.productPrices
      .filter((p) => String(p.price || '').trim())
      .map((p) => {
        const who = p.role === 'main'
          ? 'MAIN PRODUCT'
          : String(p.stepName || p.pageType || 'UPSELL').trim();
        return `${who} PRICE (use this exact price on that step — do not invent another): ${String(p.price).trim()}`;
      })
    : [];
  if (!priceLines.length && input.price?.trim()) {
    priceLines.push(`PRODUCT PRICE (use this exact price — do not invent another): ${input.price.trim()}`);
  }
  if (priceLines.length) {
    input.description = [input.description?.trim(), priceLines.join('\n')].filter(Boolean).join('\n');
  }
  const steps: StepState[] = Array.isArray(job.steps) ? (job.steps as StepState[]) : [];
  const orderedKeys: string[] = steps.length > 0 ? steps.map((s) => s.key) : [...STEP_ORDER];

  const persistSteps = async (patch: Record<string, unknown> = {}) => {
    await supabase.from('pipeline_jobs').update({ steps, ...patch }).eq('id', jobId);
  };

  try { await clearChimeraFunnelJunk(supabase, projectId); } catch { /* leftover docs in Funnel Builder */ }

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
      if (OPTIONAL_STEPS.has(key as StepKey)) {
        await persistSteps({ status: 'running', current_step: key, error: null });
        log('step', key, '→ failed (continuing):', msg);
        continue;
      }
      await persistSteps({ status: 'failed', current_step: key, error: `Step ${key}: ${msg}`.slice(0, 1000) });
      log('step', key, '→ failed:', msg);
      return new Response('failed', { status: 200 });
    }
  }

  log('done');
  return new Response('done', { status: 200 });
};
