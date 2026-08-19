import { createClient } from '@supabase/supabase-js';
import { getCoreKnowledge, getKnowledgeForTask } from '../../src/knowledge/copywriting';

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

const STEP_ORDER = ['market_research', 'brief', 'competitor', 'ads', 'landing'] as const;
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
// Prompt helpers
// ---------------------------------------------------------------------------

function marketDirective(input: PipelineInput): string {
  const geo = (input.market || input.language || '').trim()
    || 'infer the target market/geography from the product description; if none is stated, assume a broad English-speaking market (US)';
  return `TARGET MARKET / GEOGRAPHY: ${geo}.
- Research the audience, competitors, buying habits, price points and regulatory context of THIS geography.
- WRITE ALL OUTPUT IN ENGLISH. This is a strategy document for the team; localization into the market's local language happens later, during ad/landing production.`;
}

function brandNameFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, '');
    const base = host.split('.')[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch { return 'Competitor'; }
}
function isMetaAdLibrary(url: string): boolean { return /facebook\.com\/ads\/library/i.test(url); }

interface AdConcept { angle: string; body: string; }
function parseAdConcepts(raw: string): AdConcept[] {
  const blocks = raw.split(/\n-{2,}\n|\n---\n/g).map((b) => b.trim()).filter(Boolean);
  const out: AdConcept[] = [];
  for (const b of blocks) {
    const get = (label: string) => {
      const m = b.match(new RegExp(`${label}\\s*:\\s*(.+)`, 'i'));
      return m ? m[1].trim() : '';
    };
    const angle = get('ANGOLO') || get('ANGLE');
    if (!angle && !get('HEADLINE')) continue;
    out.push({
      angle: angle || 'Concept',
      body: [get('HOOK'), get('HEADLINE'), get('BODY'), get('CTA') ? `CTA: ${get('CTA')}` : '']
        .filter(Boolean).join('\n'),
    });
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
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered&media_type=all`;
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
    flow_name: opts.flowName || 'Autopilot',
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
    const originalName = `Autopilot — ${displayName}`;

    // Clean up previous Autopilot file(s) of this type.
    const { data: prev } = await supabase
      .from('project_files')
      .select('id, file_path')
      .eq('project_id', projectId)
      .eq('file_type', fileType)
      .like('original_name', 'Autopilot — %');
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
    .update({ market_research: toSectionBlob('Autopilot — Market Research (RMBC).md', content) })
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
    await supabase.from('projects').update({ brief_files: toSectionBlob('Autopilot — Product Brief.md', content) }).eq('id', projectId);
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

/** Parse a Claude keyword list (one per line / comma) into clean terms. */
function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of (raw || '').split(/[\n,]+/)) {
    const k = line
      .replace(/^[\s\-*0-9.)\]]+/, '')      // strip bullets / numbering
      .replace(/^["'`]+|["'`]+$/g, '')       // strip quotes
      .trim();
    if (k.length < 2 || k.length > 60) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
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
  const kwInstructions = `You are a media buyer doing competitor research for the ${geo} market. Output the BEST 5 SEARCH KEYWORDS to find LOCAL competitors' ads in the Meta Ad Library, TikTok Ad Library and Google Ads Transparency Center for ${geo}.
CRITICAL RULES:
- Write the keywords in the LOCAL LANGUAGE actually spoken by consumers/advertisers in ${geo} (e.g. German for a German market). Do NOT output English keywords unless the market itself is English-speaking. English keywords surface the wrong (foreign) brands.
- Use the exact words a native buyer would type: the product category, the core benefit/outcome, and the problem — phrased the way a local advertiser writes ad copy.
- Include 1-2 REAL local competitor/brand names in this niche for ${geo} if you know them.
- NEVER output generic platform/tech/agency terms (e.g. "shopify", "ecommerce", "dropshipping", "print on demand", "agency") — only product- and market-specific terms.
- Output ONLY the keywords, one per line. No numbering, no explanations.`;
  const kwUser = `Product: ${productName}\nMarket: ${input.market || country}\n${link ? `Competitor link: ${link}\n` : ''}\nGive the keywords now.`;
  const kwRaw = await callClaude({ task: 'ad', instructions: kwInstructions, brief, marketResearch: research, userMessage: kwUser, maxTokens: 300 });

  let keywords = parseKeywords(kwRaw);
  if (link) {
    const brand = brandNameFromUrl(link);
    if (brand && brand !== 'Saved creatives') keywords.unshift(brand);
  }
  if (keywords.length === 0) keywords = [productName.split('/')[0].trim() || 'competitor'];
  // Cap the number of keyword searches per platform to control Apify spend.
  const searchTerms = keywords.slice(0, 2);

  const base = siteBaseUrl();
  const token = process.env.APIFY_KEY || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  if (!token || !base) {
    return {
      summary: !token ? 'Competitor keywords generated (Apify not configured: APIFY_KEY missing).' : 'Competitor keywords generated (URL env missing).',
      output: `Search keywords:\n- ${keywords.join('\n- ')}`,
    };
  }
  const secret = process.env.APIFY_WEBHOOK_SECRET || process.env.CRON_SECRET || '';

  // Build a discovery webhook URL (no brandId → ingestion creates one brand
  // per advertiser found, "divided by page").
  const webhookFor = (platform: string): string => {
    const params = new URLSearchParams({ projectId, platform });
    if (secret) params.set('secret', secret);
    return `${base}/api/apify/webhook?${params.toString()}`;
  };

  // 2) Fire the scrapes across all three networks.
  const runs: string[] = [];
  const started: Array<{ platform: string; keyword: string; runId: string }> = [];

  // Meta / Facebook — one keyword search per term (or the pasted library URL).
  if (link && isMetaAdLibrary(link)) {
    const run = await startApifyAdsRun(link, 25, webhookFor('meta'));
    if (run.ok) { started.push({ platform: 'meta', keyword: '(link)', runId: run.runId! }); }
    else runs.push(`Meta(link): ${run.error}`);
  }
  for (const kw of searchTerms) {
    const metaUrl = fbAdLibrarySearchUrl(kw, country);
    const run = await startApifyAdsRun(metaUrl, 25, webhookFor('meta'));
    if (run.ok) started.push({ platform: 'meta', keyword: kw, runId: run.runId! });
    else runs.push(`Meta(${kw}): ${run.error}`);

    const tk = await startApifyTiktokRun(kw, country, 25, webhookFor('tiktok'));
    if (tk.ok) started.push({ platform: 'tiktok', keyword: kw, runId: tk.runId! });
    else runs.push(`TikTok(${kw}): ${tk.error}`);

    const gg = await startApifyGoogleRun(kw, country, 25, webhookFor('google'));
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
    started.length ? `\nStarted runs:\n${started.map((s) => `- ${s.platform} · "${s.keyword}" · run ${s.runId}`).join('\n')}` : '',
    runs.length ? `\nErrors:\n${runs.map((r) => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  return { summary, output };
}

async function runAds(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);

  const instructions = `Sei un direct response copywriter esperto in creativi ad alta conversione.
Genera 5 CONCEPT PUBBLICITARI distinti per questo prodotto.
${marketDirective(input)}
Per OGNI concept usa ESATTAMENTE questo formato, separando i concept con una riga "---":

ANGOLO: <nome sintetico dell'angolo>
HOOK: <prima riga / scroll-stopper>
HEADLINE: <headline principale>
BODY: <2-4 frasi di corpo persuasivo>
CTA: <call to action>

Gli angoli devono essere davvero diversi tra loro (meccanismo, paura, desiderio, identità, prova sociale...). Nessun testo extra fuori dal formato.`;

  const userMessage = `Prodotto: ${(project.name as string) || input.product || ''}
Genera i 5 concept basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const raw = await callClaude({ task: 'ad', instructions, brief, marketResearch: research, userMessage, maxTokens: 3000 });
  const concepts = parseAdConcepts(raw);

  let saved = 0;
  if (concepts.length > 0) {
    const rows = concepts.map((c) => ({
      project_id: projectId,
      type: 'concept',
      angle: c.angle.slice(0, 300),
      concept_notes: c.body,
      output_status: 'ready',
    }));
    const { error } = await supabase.from('creative_outputs').insert(rows);
    if (!error) saved = rows.length;
  }

  // Make the concepts VISIBLE in the Funnel tab (the Creative tab APIs are not
  // wired in this build) by saving a readable HTML doc as a funnel step.
  const html = adsConceptsToHtml(raw, concepts);
  try {
    await createFunnelStep(supabase, projectId, {
      stepNumber: 90,
      pageName: 'Angles & Ads (Autopilot)',
      stepType: 'ads',
      resultContent: html,
    });
  } catch { /* non-fatal */ }

  return {
    summary: `${concepts.length || 5} ad concepts generated — visible in the Funnel tab ("Angles & Ads")${saved ? ` and saved to creative_outputs (${saved})` : ''}.`,
    output: raw,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function adsConceptsToHtml(raw: string, concepts: AdConcept[]): string {
  const cards = concepts.length
    ? concepts.map((c, i) => `
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:12px 0;background:#fff">
        <div style="font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:.04em">Concept ${i + 1} — ${esc(c.angle)}</div>
        <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0 0;color:#111827">${esc(c.body)}</pre>
      </div>`).join('')
    : `<pre style="white-space:pre-wrap">${esc(raw)}</pre>`;
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;padding:8px">
    <h1 style="font-size:20px;margin:0 0 4px">Angles &amp; Ads generated by Autopilot</h1>
    <p style="color:#6b7280;margin:0 0 12px">${concepts.length || 0} concepts ready for creative production.</p>
    ${cards}
  </div>`;
}

async function runLanding(supabase: SupabaseClient, projectId: string, input: PipelineInput): Promise<StepResult> {
  const project = await loadProject(supabase, projectId);
  const research = sectionContentFrom(project.market_research);
  const brief = typeof project.brief === 'string' && project.brief.trim() ? (project.brief as string) : sectionContentFrom(project.brief);

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

  const userMessage = `Prodotto: ${(project.name as string) || input.product || ''}
Scrivi la landing completa basandoti su brief e ricerca di mercato forniti nel contesto.`;

  const content = await callClaude({ task: 'pdp', instructions, brief, marketResearch: research, userMessage, maxTokens: 4096 });
  if (!content) throw new Error('Landing returned empty output');

  const { error } = await supabase
    .from('projects')
    .update({ funnel: toSectionBlob('AI — Landing copy', content) })
    .eq('id', projectId);
  if (error) throw new Error(`Failed to save funnel: ${error.message}`);

  // Build a real, visible HTML landing MOCKUP from the copy, optionally using
  // a chosen funnel template as a design reference (fetched via Jina, no
  // headless browser). Saved as a funnel step → visible/previewable in the
  // Funnel tab.
  const templateRef = await fetchTemplateReference((input.templateUrl || '').trim());
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
${templateRef ? '- Usa lo STILE/STRUTTURA della pagina di riferimento fornita come ispirazione (layout, ordine sezioni, tono), ma con contenuti del nostro prodotto.' : ''}
Rispondi SOLO con l'HTML, senza spiegazioni e senza \`\`\`.`;

    const mockupUser = `COPY DELLA LANDING (da usare):\n\n${content}\n\n${templateRef ? `PAGINA DI RIFERIMENTO (stile/struttura da imitare):\n\n${templateRef}` : ''}`;
    let mockup = await callClaude({ task: 'pdp', instructions: mockupInstructions, userMessage: mockupUser, maxTokens: 8000 });
    mockup = mockup.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();
    if (mockup.toLowerCase().includes('<html') || mockup.toLowerCase().includes('<!doctype')) {
      await createFunnelStep(supabase, projectId, {
        stepNumber: 1,
        pageName: 'Landing (Autopilot)',
        stepType: 'landing',
        resultContent: mockup,
      });
      mockupSaved = true;
    }
  } catch { /* non-fatal: copy is already saved */ }

  return {
    summary: mockupSaved
      ? 'Landing generated: copy in the Funnel section + HTML mockup visible in the Funnel tab.'
      : 'Landing copy generated and saved to the Funnel section.',
    output: content,
  };
}

const RUNNERS: Record<StepKey, (s: SupabaseClient, p: string, i: PipelineInput) => Promise<StepResult>> = {
  market_research: runMarketResearch,
  brief: runBrief,
  competitor: runCompetitor,
  ads: runAds,
  landing: runLanding,
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
