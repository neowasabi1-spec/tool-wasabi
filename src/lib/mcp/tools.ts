/**
 * MCP tool implementations.
 *
 * These orchestrate the EXISTING, battle-tested API routes so the MCP path
 * inherits all the clone/extract/finalize behaviour (SPA rescue, Rocket
 * Loader neutralisation, universal text extraction, SPA-aware DOM replacer)
 * with zero duplicated logic:
 *
 *   clone_landing_page -> POST /api/landing/clone
 *   extract_texts      -> POST /api/landing/swipe/openclaw-build-prompts
 *   apply_rewrites     -> POST /api/landing/swipe/openclaw-finalize
 *
 * The LLM rewrite step lives with the CALLER (the user's Claude), not here —
 * that is the whole point of exposing this as an MCP server.
 */
import { randomUUID } from 'node:crypto';
import { getBaseUrl } from './base-url';
import { currentApiKey } from './context';
import {
  getAsset,
  newAssetId,
  saveAsset,
  updateAsset,
  type McpAsset,
} from './asset-store';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `HTTP ${res.status}`;
    throw new Error(`${path} failed: ${msg}`);
  }
  return json as T;
}

/**
 * Call a key-authed `/api/v1/*` route, forwarding the caller's `fsk_` API key
 * (captured in the MCP request context). These routes back the Projects,
 * Templates, Archive and Funnels sections of the tool — reusing them means MCP
 * writes land in the exact same tables the UI reads, so they show up in-app.
 */
async function v1<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = currentApiKey();
  if (!key) {
    throw new Error(
      'This tool needs an fsk_ API key. Connect the MCP server with your ' +
        'X-API-Key (fsk_…) — the key must have full_access (or the matching ' +
        'read/write permission for this section).',
    );
  }
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `HTTP ${res.status}`;
    throw new Error(`${path} failed: ${msg}`);
  }
  return json as T;
}

export interface CloneResult {
  assetId: string;
  title: string;
  htmlLength: number;
  wasSpa: boolean;
  scriptsKept: boolean;
  previewUrl: string;
}

export async function cloneLandingPage(
  ownerId: string,
  url: string,
  scriptsMode: 'auto' | 'keep' | 'strip' = 'auto',
): Promise<CloneResult> {
  const cloned = await postJson<{
    success: boolean;
    html: string;
    title: string;
    was_spa: boolean;
    scripts_kept: boolean;
    content_length: number;
  }>('/api/landing/clone', { url, scripts_mode: scriptsMode });

  const id = newAssetId();
  const now = Date.now();
  const asset: McpAsset = {
    id,
    ownerId,
    sourceUrl: url,
    title: cloned.title || '',
    html: cloned.html,
    createdAt: now,
    updatedAt: now,
  };
  await saveAsset(asset);

  return {
    assetId: id,
    title: asset.title,
    htmlLength: cloned.html.length,
    wasSpa: !!cloned.was_spa,
    scriptsKept: !!cloned.scripts_kept,
    previewUrl: `${getBaseUrl()}/api/mcp/asset/${id}?variant=original`,
  };
}

async function loadOwnedAsset(ownerId: string, assetId: string): Promise<McpAsset> {
  const asset = await getAsset(assetId);
  if (!asset) throw new Error(`Unknown assetId "${assetId}" (clone the page first).`);
  if (asset.ownerId !== ownerId) throw new Error('This asset belongs to another user.');
  return asset;
}

export interface ExtractedForClaude {
  assetId: string;
  totalTexts: number;
  texts: Array<{ id: number; text: string; tag: string }>;
}

export async function extractTexts(
  ownerId: string,
  assetId: string,
): Promise<ExtractedForClaude> {
  const asset = await loadOwnedAsset(ownerId, assetId);

  const built = await postJson<{
    success: boolean;
    texts: Array<{ id: number; original: string; tag: string; position: number }>;
    totalTexts: number;
  }>('/api/landing/swipe/openclaw-build-prompts', {
    html: asset.html,
    sourceUrl: asset.sourceUrl,
    // build-prompts requires a product name to assemble its (unused-here)
    // rewrite prompt; the extraction itself is product-agnostic.
    product: { name: 'target' },
  });

  const texts = built.texts.map((t) => ({ id: t.id, original: t.original, tag: t.tag }));
  await updateAsset(assetId, { texts });

  return {
    assetId,
    totalTexts: built.totalTexts,
    texts: texts.map((t) => ({ id: t.id, text: t.original, tag: t.tag })),
  };
}

export interface ApplyResult {
  assetId: string;
  previewUrl: string;
  downloadUrl: string;
  replacements: number;
  coverageRatio: number;
  unresolvedTextIds: number[];
  newTitle: string;
}

export async function applyRewrites(
  ownerId: string,
  assetId: string,
  rewrites: Array<{ id: number; rewritten: string }>,
): Promise<ApplyResult> {
  const asset = await loadOwnedAsset(ownerId, assetId);
  if (!asset.texts || asset.texts.length === 0) {
    throw new Error('Call extract_texts before apply_rewrites for this asset.');
  }

  const finalized = await postJson<{
    success: boolean;
    html: string;
    replacements: number;
    coverage_ratio: number;
    unresolved_text_ids: number[];
    new_title: string;
  }>('/api/landing/swipe/openclaw-finalize', {
    html: asset.html,
    sourceUrl: asset.sourceUrl,
    texts: asset.texts,
    rewrites,
  });

  await updateAsset(assetId, { resultHtml: finalized.html });

  const base = getBaseUrl();
  return {
    assetId,
    previewUrl: `${base}/api/mcp/asset/${assetId}`,
    downloadUrl: `${base}/api/mcp/asset/${assetId}?download=1`,
    replacements: finalized.replacements,
    coverageRatio: finalized.coverage_ratio,
    unresolvedTextIds: finalized.unresolved_text_ids || [],
    newTitle: finalized.new_title || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION TOOLS — expose the rest of the app (Projects, Templates, Archive,
// Funnels) via the same fsk_-key `/api/v1/*` routes the UI uses, so anything
// Neo/Morfeo do through MCP shows up inside the tool.
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  status?: string;
  description?: string | null;
  domain?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** List all projects (optionally filtered by status). */
export async function listProjects(status?: string): Promise<{
  count: number;
  projects: Array<{ id: string; name: string; status?: string; description?: string | null; created_at?: string }>;
}> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await v1<{ projects: ProjectRow[]; count: number }>('GET', `/api/v1/projects${qs}`);
  return {
    count: res.count ?? res.projects?.length ?? 0,
    projects: (res.projects || []).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      description: p.description ?? null,
      created_at: p.created_at,
    })),
  };
}

/** Get a single project plus its funnel pages, templates and archived funnels. */
export async function getProject(projectId: string): Promise<unknown> {
  if (!projectId) throw new Error("Missing required argument 'projectId'.");
  return v1('GET', `/api/v1/projects?id=${encodeURIComponent(projectId)}`);
}

/** Create a new project. */
export async function createProject(
  name: string,
  opts: { description?: string; status?: string; tags?: string[]; notes?: string } = {},
): Promise<{ id: string; name: string }> {
  if (!name?.trim()) throw new Error("Missing required argument 'name'.");
  const res = await v1<{ project: ProjectRow }>('POST', '/api/v1/projects', {
    name: name.trim(),
    description: opts.description ?? '',
    status: opts.status ?? 'active',
    tags: opts.tags ?? [],
    notes: opts.notes ?? '',
  });
  return { id: res.project.id, name: res.project.name };
}

/** List the swipe-template catalog. */
export async function listTemplates(): Promise<{ count: number; templates: unknown[] }> {
  const res = await v1<{ templates: unknown[] }>('GET', '/api/v1/templates');
  return { count: res.templates?.length ?? 0, templates: res.templates || [] };
}

/** List saved pages / funnels in My Archive (the "By Type" / Template section). */
export async function listSavedPages(): Promise<{
  count: number;
  pages: Array<{ id: string; name: string; section?: string; total_steps?: number; project_id?: string | null; created_at?: string }>;
}> {
  const res = await v1<{ archived_funnels: Array<Record<string, unknown>> }>('GET', '/api/v1/archive');
  const rows = res.archived_funnels || [];
  return {
    count: rows.length,
    pages: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      section: r.section as string | undefined,
      total_steps: r.total_steps as number | undefined,
      project_id: (r.project_id as string | null) ?? null,
      created_at: r.created_at as string | undefined,
    })),
  };
}

export interface SavePageResult {
  pageId: string;
  name: string;
  section: string;
  previewUrl: string;
  editorUrl: string;
  archived: boolean;
}

/**
 * Save an HTML page into My Archive so it appears in the tool's "By Type" /
 * Template section (and, if projectId is given, under that project). Stores the
 * HTML in page_html (via /api/funnel-html) and inserts an archived_funnels row
 * whose step points at that HTML — exactly the shape the UI + editor expect.
 */
export async function savePageToArchive(args: {
  name: string;
  html: string;
  sourceUrl?: string;
  pageType?: string;
  category?: string;
  tags?: string[];
  section?: 'funnel' | 'quiz';
  projectId?: string;
}): Promise<SavePageResult> {
  const name = (args.name || '').trim();
  if (!name) throw new Error("Missing required argument 'name'.");
  if (!args.html || args.html.length < 30) throw new Error("Missing or too-short 'html'.");

  const pageId = randomUUID();
  const base = getBaseUrl();
  const pageType = args.pageType || 'landing';
  const section = args.section || 'funnel';
  const htmlUrl = `/api/funnel-html?pageId=${pageId}&kind=cloned&variant=desktop`;

  const step = {
    step_index: 1,
    name,
    page_type: pageType,
    category: args.category || '',
    url_to_swipe: args.sourceUrl || '',
    cloned_data: {
      title: name,
      source_url: args.sourceUrl || '',
      method_used: 'mcp',
      cloned_at: new Date().toISOString(),
      category: args.category || '',
      tags: args.tags || [],
      htmlUrl,
    },
  };

  // 1) Insert the archive row with a known id (so the htmlUrl above resolves).
  await v1('POST', '/api/v1/archive', {
    id: pageId,
    name,
    total_steps: 1,
    steps: [step],
    section,
    ...(args.projectId ? { project_id: args.projectId } : {}),
  });

  // 2) Persist the HTML blob keyed by that page id. /api/funnel-html is not
  //    key-authed (JWT optional) so we call it without the fsk_ header.
  await postJson('/api/funnel-html', {
    pageId,
    kind: 'cloned',
    variant: 'desktop',
    html: args.html,
  });

  return {
    pageId,
    name,
    section,
    previewUrl: `${base}${htmlUrl}`,
    editorUrl: `${base}/edit/${pageId}`,
    archived: true,
  };
}

/**
 * Persist a previously cloned/swiped MCP asset into My Archive so it stops
 * living only in the MCP blob store and shows up inside the tool. Uses the
 * rewritten result when available, otherwise the original clone.
 */
export async function saveSwipeToArchive(
  ownerId: string,
  args: { assetId: string; name?: string; pageType?: string; category?: string; tags?: string[]; projectId?: string },
): Promise<SavePageResult> {
  const asset = await loadOwnedAsset(ownerId, args.assetId);
  const html = asset.resultHtml || asset.html;
  if (!html) throw new Error('This asset has no HTML yet — clone the page first.');
  return savePageToArchive({
    name: args.name || asset.title || asset.sourceUrl || 'MCP page',
    html,
    sourceUrl: asset.sourceUrl,
    pageType: args.pageType,
    category: args.category,
    tags: args.tags,
    projectId: args.projectId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPETITOR LIBRARY TOOLS — the server-backed actions the browser extension
// performs (save creative, add/scrape competitor, list). These call the same
// fsk_-keyed /api/v1/* routes the UI/extension use, so Neo/Morfeo write into the
// exact same competitor_brands / competitor_ads tables the Project Hub reads.
// ─────────────────────────────────────────────────────────────────────────────

/** List competitor brands (optionally scoped to a project), with creative counts. */
export async function listCompetitors(projectId?: string): Promise<{ count: number; competitors: unknown[] }> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await v1<{ competitors: unknown[]; count: number }>('GET', `/api/v1/competitors${qs}`);
  return { count: res.count ?? res.competitors?.length ?? 0, competitors: res.competitors || [] };
}

/** Add (or reuse) a competitor brand in a project. Optionally enable monitoring. */
export async function addCompetitor(args: {
  projectId: string;
  name: string;
  adsLibraryUrl?: string;
  frequency?: string;
  scrapeCount?: number;
  autoScrape?: boolean;
}): Promise<unknown> {
  if (!args.projectId?.trim()) throw new Error("Missing required argument 'projectId'.");
  if (!args.name?.trim()) throw new Error("Missing required argument 'name'.");
  const res = await v1<{ competitor: unknown }>('POST', '/api/v1/competitors', {
    projectId: args.projectId,
    name: args.name.trim(),
    adsLibraryUrl: args.adsLibraryUrl,
    frequency: args.frequency,
    scrapeCount: args.scrapeCount,
    autoScrape: args.autoScrape,
  });
  return res.competitor;
}

/** Kick off an Apify Ad Library scrape for a competitor (creates it if needed). */
export async function scrapeCompetitor(args: {
  projectId: string;
  brandId?: number;
  name?: string;
  adsLibraryUrl?: string;
}): Promise<unknown> {
  if (!args.projectId?.trim()) throw new Error("Missing required argument 'projectId'.");
  return v1('POST', '/api/v1/competitors/scrape', {
    projectId: args.projectId,
    brandId: args.brandId,
    name: args.name,
    adsLibraryUrl: args.adsLibraryUrl,
  });
}

/** Save one creative (image/video) from a URL into a project's Competitor Library. */
export async function saveCreative(args: {
  projectId: string;
  mediaUrl: string;
  mediaType?: 'image' | 'video';
  pageUrl?: string;
  brandId?: number;
  brandName?: string;
  name?: string;
  headline?: string;
  hook?: string;
  bodyText?: string;
}): Promise<unknown> {
  if (!args.projectId?.trim()) throw new Error("Missing required argument 'projectId'.");
  if (!args.mediaUrl?.trim()) throw new Error("Missing required argument 'mediaUrl'.");
  return v1('POST', '/api/v1/creatives', {
    projectId: args.projectId,
    mediaUrl: args.mediaUrl.trim(),
    mediaType: args.mediaType,
    pageUrl: args.pageUrl,
    brandId: args.brandId,
    brandName: args.brandName,
    name: args.name,
    headline: args.headline,
    hook: args.hook,
    bodyText: args.bodyText,
  });
}

/** List saved creatives in a project (optionally for one competitor). */
export async function listCreatives(args: { projectId: string; brandId?: number }): Promise<{ count: number; creatives: unknown[] }> {
  if (!args.projectId?.trim()) throw new Error("Missing required argument 'projectId'.");
  const qs = new URLSearchParams({ projectId: args.projectId });
  if (args.brandId) qs.set('brandId', String(args.brandId));
  const res = await v1<{ creatives: unknown[]; count: number }>('GET', `/api/v1/creatives?${qs.toString()}`);
  return { count: res.count ?? res.creatives?.length ?? 0, creatives: res.creatives || [] };
}

/** List funnel pages (Front-End Funnel workspace). */
export async function listFunnels(): Promise<{ count: number; funnels: unknown[] }> {
  const res = await v1<{ funnels: unknown[] }>('GET', '/api/v1/funnels');
  return { count: res.funnels?.length ?? 0, funnels: res.funnels || [] };
}

/** Create or update a funnel page (pass-through to the funnel_pages table). */
export async function saveFunnelPage(body: Record<string, unknown>): Promise<unknown> {
  if (!body || typeof body !== 'object') throw new Error('Missing funnel page body.');
  return v1('POST', '/api/v1/funnels', body);
}
