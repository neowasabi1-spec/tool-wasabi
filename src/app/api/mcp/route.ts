export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * MCP endpoint — dependency-free, supports BOTH MCP transports.
 *
 * History: this route used to depend on `mcp-handler` + `@modelcontextprotocol/sdk`.
 * Those packages were declared but never made it into the installed lockfile,
 * which broke the production build, so a previous change stubbed this route to
 * return 503. That stub is why connected Claude clients (Neo / Morfeo) reported
 * "the MCP server is down".
 *
 * We reimplement MCP directly (tiny JSON-RPC surface) over the already-present
 * tool implementations (src/lib/mcp/tools.ts) + per-user OAuth / shared-key auth
 * (src/lib/mcp/auth.ts). No npm install required, so the build can never break
 * on a missing MCP dependency again.
 *
 * Transports supported:
 *   1. HTTP+SSE (protocol 2024-11-05) — the transport OpenClaw uses:
 *        GET  /api/mcp                     → opens an SSE stream, first emits an
 *                                            `endpoint` event with the POST URL.
 *        POST /api/mcp?sessionId=<id>      → JSON-RPC message; the RESPONSE is
 *                                            delivered back over that SSE stream,
 *                                            the POST itself returns 202.
 *   2. Streamable HTTP (protocol 2025+):
 *        POST /api/mcp (no sessionId)      → JSON-RPC message; response returned
 *                                            inline in the POST body.
 *
 * The SSE session registry is a module-level Map (per server instance), exactly
 * like the reference SDK's SSEServerTransport. GET and POST for the same session
 * must land on the same warm instance — true in practice for a single worker.
 */
import { randomUUID } from 'node:crypto';
import { resolveOwnerAsync, unauthorizedResponse } from '@/lib/mcp/auth';
import { mcpContext } from '@/lib/mcp/context';
import {
  cloneLandingPage,
  extractTexts,
  applyRewrites,
  listProjects,
  getProject,
  createProject,
  listTemplates,
  listSavedPages,
  savePageToArchive,
  saveSwipeToArchive,
  listFunnels,
  saveFunnelPage,
  listCompetitors,
  addCompetitor,
  scrapeCompetitor,
  saveCreative,
  listCreatives,
  listCreativeFolders,
  createCreativeFolder,
  saveProjectCreative,
  listProjectCreatives,
  updateProjectCreative,
  deleteProjectCreative,
} from '@/lib/mcp/tools';

/** Pull the raw fsk_ API key off the request so tools can reuse /api/v1/*. */
function extractApiKey(req: Request): string {
  return (
    req.headers.get('x-api-key') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
    ''
  );
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'tool-wasabi', version: '1.0.0' } as const;

// JSON-RPC error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ── SSE session registry (module-level, per server instance) ────────────────
interface SseSession {
  controller: ReadableStreamDefaultController<Uint8Array>;
  ownerId: string;
  heartbeat: ReturnType<typeof setInterval>;
}
const sseSessions = new Map<string, SseSession>();
const encoder = new TextEncoder();

function sseWrite(controller: ReadableStreamDefaultController<Uint8Array>, chunk: string): void {
  controller.enqueue(encoder.encode(chunk));
}
function sseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string | null,
  data: string,
): void {
  sseWrite(controller, (event ? `event: ${event}\n` : '') + `data: ${data}\n\n`);
}

// ── Tool catalog (JSON schemas advertised to the MCP client) ────────────────
const TOOLS = [
  {
    name: 'clone_landing_page',
    description:
      'Clone a landing page by URL into a private asset. Runs the full clone pipeline (SPA rescue, Rocket Loader neutralisation, asset absolutisation). Returns an assetId used by the other tools plus a preview URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the landing page to clone.' },
        scripts_mode: {
          type: 'string',
          enum: ['auto', 'keep', 'strip'],
          description:
            "How to handle the page's <script> tags. 'auto' (default) keeps functional scripts on pages that need them (live chat, counters, quizzes), 'keep' always keeps, 'strip' removes all.",
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extract_texts',
    description:
      'Extract the rewritable copy from a previously cloned asset. Returns an ordered list of {id, text, tag}. YOU (the calling Claude) then rewrite each text and send them back via apply_rewrites.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'The assetId returned by clone_landing_page.' },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'apply_rewrites',
    description:
      'Apply your rewritten texts back into the cloned asset using the SPA-aware DOM replacer. Returns preview + download URLs and coverage stats.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'The assetId returned by clone_landing_page.' },
        rewrites: {
          type: 'array',
          description: 'One object per rewritten text.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'The text id from extract_texts.' },
              rewritten: { type: 'string', description: 'The rewritten copy for this id.' },
            },
            required: ['id', 'rewritten'],
          },
        },
      },
      required: ['assetId', 'rewrites'],
    },
  },
  // ── Section tools: expose the rest of the app so results show up in-app ──
  {
    name: 'list_projects',
    description:
      'List the projects in the tool. Optionally filter by status. Returns id + name for each — use the id with get_project or when saving pages/funnels into a project.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: "Optional status filter, e.g. 'active'." },
      },
    },
  },
  {
    name: 'get_project',
    description:
      'Get one project with its funnel pages, swipe templates and archived (saved) pages.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'The project id from list_projects.' } },
      required: ['projectId'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        description: { type: 'string' },
        status: { type: 'string', description: "Defaults to 'active'." },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_templates',
    description: 'List the swipe-template catalog (the Templates section).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_saved_pages',
    description:
      'List the pages/funnels saved in My Archive (the "By Type" / Template section), including quizzes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_page_to_archive',
    description:
      'Save an HTML page into My Archive so it appears in the tool (By Type / Template section). If projectId is given it is also linked to that project. Returns preview + editor URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the saved page.' },
        html: { type: 'string', description: 'The full HTML of the page.' },
        sourceUrl: { type: 'string', description: 'Original URL, if any.' },
        pageType: {
          type: 'string',
          description: "Page type for the 'By Type' grouping (e.g. landing, advertorial, vsl, quiz, checkout). Defaults to 'landing'.",
        },
        category: { type: 'string', description: 'Optional niche/category (e.g. Weight loss).' },
        tags: { type: 'array', items: { type: 'string' } },
        section: { type: 'string', enum: ['funnel', 'quiz'], description: "Defaults to 'funnel'." },
        projectId: { type: 'string', description: 'Optional project id to link the page to.' },
      },
      required: ['name', 'html'],
    },
  },
  {
    name: 'save_swipe_to_archive',
    description:
      'Persist a previously cloned/swiped MCP asset (from clone_landing_page / apply_rewrites) into My Archive so it shows up inside the tool instead of only living in the MCP store. Uses the rewritten result when available.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'The assetId from clone_landing_page / apply_rewrites.' },
        name: { type: 'string', description: 'Optional display name (defaults to the page title).' },
        pageType: { type: 'string', description: "Optional page type. Defaults to 'landing'." },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        projectId: { type: 'string', description: 'Optional project id to link the page to.' },
      },
      required: ['assetId'],
    },
  },
  // ── Competitor Library tools (what the browser extension does, server-side) ──
  {
    name: 'list_competitors',
    description:
      "List competitor brands in the Competitor Library, with per-brand creative counts. Optionally scope to one project. Use a brand's id with save_creative / scrape_competitor / list_creatives.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional project id to scope the list.' },
      },
    },
  },
  {
    name: 'add_competitor',
    description:
      'Add (or reuse) a competitor brand in a project. Pass adsLibraryUrl + autoScrape=true to enable scheduled Meta Ad Library monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id (from list_projects).' },
        name: { type: 'string', description: 'Competitor display name.' },
        adsLibraryUrl: { type: 'string', description: 'Meta Ad Library URL to monitor.' },
        frequency: { type: 'string', description: "Scrape cadence, e.g. 'every_7_days'." },
        scrapeCount: { type: 'number', description: 'How many ads to pull per run (default 10).' },
        autoScrape: { type: 'boolean', description: 'Enable scheduled monitoring.' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'scrape_competitor',
    description:
      'Start a Meta Ad Library scrape for a competitor now (like the "Scrape now" button). Pass an existing brandId, or name + adsLibraryUrl to create it first. Ingestion is async. Needs APIFY_KEY configured.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id.' },
        brandId: { type: 'number', description: 'Existing competitor brand id.' },
        name: { type: 'string', description: 'Competitor name (if creating on the fly).' },
        adsLibraryUrl: { type: 'string', description: 'Meta Ad Library URL (required if creating on the fly).' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'save_creative',
    description:
      "Save one competitor creative (image or video) from a URL into a project's Competitor Library — the bytes are fetched server-side and stored (videos auto-split into shots). Groups under an existing brandId, a brandName, or the source domain.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The destination project id.' },
        mediaUrl: { type: 'string', description: 'Direct http(s) URL of the image or video.' },
        mediaType: { type: 'string', enum: ['image', 'video'], description: 'Optional hint.' },
        pageUrl: { type: 'string', description: 'The page the creative was seen on (sets Referer + brand domain).' },
        brandId: { type: 'number', description: 'Save under this existing competitor.' },
        brandName: { type: 'string', description: 'Create/reuse a competitor by this name (overrides domain).' },
        name: { type: 'string', description: 'Creative label.' },
        headline: { type: 'string' },
        hook: { type: 'string' },
        bodyText: { type: 'string', description: 'Ad body / description.' },
      },
      required: ['projectId', 'mediaUrl'],
    },
  },
  {
    name: 'list_creatives',
    description:
      "List COMPETITOR ads in a project's Competitor Library (optionally filtered to one brandId). For OUR creatives (Creative → Creatives folders) use list_project_creatives.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id.' },
        brandId: { type: 'number', description: 'Optional competitor brand id filter.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_creative_folders',
    description:
      "List folders in the project's Creative → Creatives tab. Returns folderId + name + count. Use folderId with save_project_creative / list_project_creatives. Does NOT list Competitor Library brands.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id (from list_projects).' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'create_creative_folder',
    description:
      "Create a folder in Creative → Creatives (idempotent: returns the existing folder if the name already exists). Output: { folderId, name }.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id.' },
        name: { type: 'string', description: 'Folder name (e.g. UGC, Hooks).' },
      },
      required: ['projectId', 'name'],
    },
  },
  {
    name: 'save_project_creative',
    description:
      "Save an image or video into the project's Creative → Creatives tab (NOT Competitor Library). Pass folderId or folderName, and mediaUrl or filePath. Copy (headline, hook, bodyText) is stored on the same card.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The destination project id.' },
        folderId: { type: 'number', description: 'Folder id from create_creative_folder / list_creative_folders.' },
        folderName: { type: 'string', description: 'Folder name (created if missing). Use this OR folderId.' },
        mediaUrl: { type: 'string', description: 'Direct http(s) URL of the image or video.' },
        filePath: { type: 'string', description: 'Existing storage path if the file is already uploaded. Use this OR mediaUrl.' },
        mediaType: { type: 'string', enum: ['image', 'video'] },
        name: { type: 'string', description: 'Creative title.' },
        headline: { type: 'string' },
        hook: { type: 'string' },
        bodyText: { type: 'string', description: 'Ad body / script stored on the card.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'list_project_creatives',
    description:
      "List creatives in Creative → Creatives (image/video + headline/hook/bodyText + folder). Optional folderId filter. Not competitor ads.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'The project id.' },
        folderId: { type: 'number', description: 'Optional folder id from list_creative_folders.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'update_project_creative',
    description:
      'Update a Creative-tab item: rename, move (folderId or folderName), or change headline / hook / bodyText.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        id: { type: 'number', description: 'Creative id from list_project_creatives.' },
        name: { type: 'string' },
        folderId: { type: 'number' },
        folderName: { type: 'string' },
        headline: { type: 'string' },
        hook: { type: 'string' },
        bodyText: { type: 'string' },
      },
      required: ['projectId', 'id'],
    },
  },
  {
    name: 'delete_project_creative',
    description:
      'Delete a creative or a folder from Creative → Creatives. Deleting a folder keeps the creatives and moves them to Uncategorized.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        id: { type: 'number', description: 'Creative id, or folderId to delete a folder.' },
      },
      required: ['projectId', 'id'],
    },
  },
  {
    name: 'list_funnels',
    description: 'List the funnel pages in the Front-End Funnel workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'save_funnel_page',
    description:
      'Create or update a funnel page (funnel_pages table). Pass the full row; include an id to update. Advanced — prefer save_page_to_archive for saving a cloned page.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'object', description: 'The funnel_pages row fields (name, page_type, project_id, url_to_swipe, …). Include id to update.' },
      },
      required: ['page'],
    },
  },
] as const;

async function callTool(
  ownerId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'clone_landing_page': {
      const url = String(args.url || '').trim();
      if (!url) throw new Error("Missing required argument 'url'.");
      const mode = args.scripts_mode as 'auto' | 'keep' | 'strip' | undefined;
      return cloneLandingPage(ownerId, url, mode === 'keep' || mode === 'strip' ? mode : 'auto');
    }
    case 'extract_texts': {
      const assetId = String(args.assetId || '').trim();
      if (!assetId) throw new Error("Missing required argument 'assetId'.");
      return extractTexts(ownerId, assetId);
    }
    case 'apply_rewrites': {
      const assetId = String(args.assetId || '').trim();
      if (!assetId) throw new Error("Missing required argument 'assetId'.");
      const rewrites = Array.isArray(args.rewrites) ? (args.rewrites as Array<{ id: number; rewritten: string }>) : [];
      if (rewrites.length === 0) throw new Error("Missing required argument 'rewrites' (non-empty array).");
      return applyRewrites(ownerId, assetId, rewrites);
    }
    // ── Section tools ────────────────────────────────────────────────────
    case 'list_projects':
      return listProjects(args.status ? String(args.status) : undefined);
    case 'get_project':
      return getProject(String(args.projectId || '').trim());
    case 'create_project':
      return createProject(String(args.name || ''), {
        description: args.description !== undefined ? String(args.description) : undefined,
        status: args.status !== undefined ? String(args.status) : undefined,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        notes: args.notes !== undefined ? String(args.notes) : undefined,
      });
    case 'list_templates':
      return listTemplates();
    case 'list_saved_pages':
      return listSavedPages();
    case 'save_page_to_archive':
      return savePageToArchive({
        name: String(args.name || ''),
        html: String(args.html || ''),
        sourceUrl: args.sourceUrl !== undefined ? String(args.sourceUrl) : undefined,
        pageType: args.pageType !== undefined ? String(args.pageType) : undefined,
        category: args.category !== undefined ? String(args.category) : undefined,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        section: args.section === 'quiz' ? 'quiz' : args.section === 'funnel' ? 'funnel' : undefined,
        projectId: args.projectId !== undefined ? String(args.projectId) : undefined,
      });
    case 'save_swipe_to_archive':
      return saveSwipeToArchive(ownerId, {
        assetId: String(args.assetId || '').trim(),
        name: args.name !== undefined ? String(args.name) : undefined,
        pageType: args.pageType !== undefined ? String(args.pageType) : undefined,
        category: args.category !== undefined ? String(args.category) : undefined,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        projectId: args.projectId !== undefined ? String(args.projectId) : undefined,
      });
    // ── Competitor Library tools ─────────────────────────────────────────
    case 'list_competitors':
      return listCompetitors(args.projectId ? String(args.projectId) : undefined);
    case 'add_competitor':
      return addCompetitor({
        projectId: String(args.projectId || ''),
        name: String(args.name || ''),
        adsLibraryUrl: args.adsLibraryUrl !== undefined ? String(args.adsLibraryUrl) : undefined,
        frequency: args.frequency !== undefined ? String(args.frequency) : undefined,
        scrapeCount: args.scrapeCount !== undefined ? Number(args.scrapeCount) : undefined,
        autoScrape: args.autoScrape === true || args.autoScrape === 'true',
      });
    case 'scrape_competitor':
      return scrapeCompetitor({
        projectId: String(args.projectId || ''),
        brandId: args.brandId !== undefined ? Number(args.brandId) : undefined,
        name: args.name !== undefined ? String(args.name) : undefined,
        adsLibraryUrl: args.adsLibraryUrl !== undefined ? String(args.adsLibraryUrl) : undefined,
      });
    case 'save_creative':
      return saveCreative({
        projectId: String(args.projectId || ''),
        mediaUrl: String(args.mediaUrl || ''),
        mediaType: args.mediaType === 'video' ? 'video' : args.mediaType === 'image' ? 'image' : undefined,
        pageUrl: args.pageUrl !== undefined ? String(args.pageUrl) : undefined,
        brandId: args.brandId !== undefined ? Number(args.brandId) : undefined,
        brandName: args.brandName !== undefined ? String(args.brandName) : undefined,
        name: args.name !== undefined ? String(args.name) : undefined,
        headline: args.headline !== undefined ? String(args.headline) : undefined,
        hook: args.hook !== undefined ? String(args.hook) : undefined,
        bodyText: args.bodyText !== undefined ? String(args.bodyText) : undefined,
      });
    case 'list_creatives':
      return listCreatives({
        projectId: String(args.projectId || ''),
        brandId: args.brandId !== undefined ? Number(args.brandId) : undefined,
      });
    case 'list_creative_folders':
      return listCreativeFolders({ projectId: String(args.projectId || '') });
    case 'create_creative_folder':
      return createCreativeFolder({
        projectId: String(args.projectId || ''),
        name: String(args.name || ''),
      });
    case 'save_project_creative':
      return saveProjectCreative({
        projectId: String(args.projectId || ''),
        folderId: args.folderId !== undefined ? Number(args.folderId) : undefined,
        folderName: args.folderName !== undefined ? String(args.folderName) : args.folder !== undefined ? String(args.folder) : undefined,
        mediaUrl: args.mediaUrl !== undefined ? String(args.mediaUrl) : undefined,
        filePath: args.filePath !== undefined ? String(args.filePath) : undefined,
        mediaType: args.mediaType === 'video' ? 'video' : args.mediaType === 'image' ? 'image' : undefined,
        name: args.name !== undefined ? String(args.name) : undefined,
        headline: args.headline !== undefined ? String(args.headline) : undefined,
        hook: args.hook !== undefined ? String(args.hook) : undefined,
        bodyText: args.bodyText !== undefined ? String(args.bodyText) : undefined,
      });
    case 'list_project_creatives':
      return listProjectCreatives({
        projectId: String(args.projectId || ''),
        folderId: args.folderId !== undefined ? Number(args.folderId) : undefined,
      });
    case 'update_project_creative':
      return updateProjectCreative({
        projectId: String(args.projectId || ''),
        id: Number(args.id),
        name: args.name !== undefined ? String(args.name) : undefined,
        folderId: args.folderId !== undefined ? Number(args.folderId) : undefined,
        folderName: args.folderName !== undefined ? String(args.folderName) : undefined,
        headline: args.headline !== undefined ? String(args.headline) : undefined,
        hook: args.hook !== undefined ? String(args.hook) : undefined,
        bodyText: args.bodyText !== undefined ? String(args.bodyText) : undefined,
      });
    case 'delete_project_creative':
      return deleteProjectCreative({
        projectId: String(args.projectId || ''),
        id: Number(args.id),
      });
    case 'list_funnels':
      return listFunnels();
    case 'save_funnel_page': {
      const page = (args.page || {}) as Record<string, unknown>;
      if (!page || typeof page !== 'object' || Object.keys(page).length === 0) {
        throw new Error("Missing required argument 'page' (funnel_pages row).");
      }
      return saveFunnelPage(page);
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

async function handleRpc(ownerId: string, msg: JsonRpcRequest): Promise<object | null> {
  const { id, method } = msg;
  const params = (msg.params || {}) as Record<string, unknown>;

  // Notifications (no id): acknowledge without a response body.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(params.name || '');
      const args = (params.arguments || {}) as Record<string, unknown>;
      if (!name) return rpcError(id, INVALID_PARAMS, "tools/call requires 'name'.");
      try {
        const result = await callTool(ownerId, name, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${method}".`);
  }
}

async function parseBody(req: Request): Promise<unknown | typeof PARSE_ERROR> {
  try {
    const raw = await req.text();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return PARSE_ERROR;
  }
}

// ── POST: JSON-RPC messages for BOTH transports ─────────────────────────────
async function handlePost(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');

  // ---- HTTP+SSE transport: message posted to an existing SSE session --------
  if (sessionId) {
    const session = sseSessions.get(sessionId);
    if (!session) {
      // The GET/SSE stream that owned this session is gone (expired, or landed
      // on a different instance). Tell the client to reconnect.
      return new Response(
        JSON.stringify(rpcError(null, INVALID_REQUEST, 'Unknown or expired sessionId — reopen the SSE stream (GET /api/mcp).')),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    // Authenticate the message. Some SSE clients send the key only on the POST
    // (not on the GET stream), so we resolve auth here and backfill the session
    // owner. OAuth clients that send nothing get the 401 discovery challenge.
    const postAuth = await resolveOwnerAsync(req);
    const ownerId = postAuth?.ownerId || session.ownerId;
    if (!ownerId) return unauthorizedResponse();
    if (!session.ownerId) session.ownerId = ownerId;

    const payload = await parseBody(req);
    if (payload === PARSE_ERROR) {
      return new Response('invalid json', { status: 400 });
    }
    const messages = Array.isArray(payload) ? (payload as JsonRpcRequest[]) : [payload as JsonRpcRequest];
    // Process and push each response back over the SSE channel.
    await mcpContext.run({ ownerId, apiKey: extractApiKey(req) }, async () => {
      for (const m of messages) {
        const resp = await handleRpc(ownerId, m);
        if (resp !== null) {
          try {
            sseEvent(session.controller, 'message', JSON.stringify(resp));
          } catch {
            /* stream closed mid-flight; client will reconnect */
          }
        }
      }
    });
    // Accepted — the actual JSON-RPC response goes over the SSE stream.
    return new Response(null, { status: 202 });
  }

  // ---- Streamable HTTP transport: respond inline ----------------------------
  const auth = await resolveOwnerAsync(req);
  if (!auth) return unauthorizedResponse();

  const payload = await parseBody(req);
  if (payload === PARSE_ERROR) {
    return new Response(JSON.stringify(rpcError(null, PARSE_ERROR, 'Invalid JSON body.')), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) {
    return new Response(JSON.stringify(rpcError(null, INVALID_REQUEST, 'Expected a JSON-RPC request object or array.')), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  return mcpContext.run({ ownerId: auth.ownerId, apiKey: extractApiKey(req) }, async () => {
    try {
      if (Array.isArray(payload)) {
        const responses = (
          await Promise.all((payload as JsonRpcRequest[]).map((m) => handleRpc(auth.ownerId, m)))
        ).filter((r): r is object => r !== null);
        if (responses.length === 0) return new Response(null, { status: 202 });
        return new Response(JSON.stringify(responses), { status: 200, headers: JSON_HEADERS });
      }
      const response = await handleRpc(auth.ownerId, payload as JsonRpcRequest);
      if (response === null) return new Response(null, { status: 202 });
      return new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify(rpcError(null, INTERNAL_ERROR, message)), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  });
}

// ── GET: open an SSE stream (HTTP+SSE transport used by OpenClaw) ────────────
async function handleGet(req: Request): Promise<Response> {
  // Open the stream even if the GET carries no auth: many SSE clients only
  // attach the key to the POST messages. Auth is enforced on the POST (above).
  // If the GET DOES carry auth we capture the owner now; otherwise it's pending
  // ('') and gets set from the first authenticated POST.
  const auth = await resolveOwnerAsync(req);

  const sessionId = randomUUID();
  const ownerId = auth?.ownerId ?? '';

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = setInterval(() => {
        try {
          sseWrite(controller, `: keep-alive ${Date.now()}\n\n`);
        } catch {
          /* closed */
        }
      }, 15000);
      sseSessions.set(sessionId, { controller, ownerId, heartbeat });
      // First event tells the client WHERE to POST its JSON-RPC messages.
      sseEvent(controller, 'endpoint', `/api/mcp?sessionId=${sessionId}`);
    },
    cancel() {
      const s = sseSessions.get(sessionId);
      if (s) {
        clearInterval(s.heartbeat);
        sseSessions.delete(sessionId);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering so events flush immediately.
      'x-accel-buffering': 'no',
    },
  });
}

// DELETE terminates a session (Streamable HTTP). We are effectively stateless
// beyond the SSE registry, so drop any matching session and acknowledge.
async function handleDelete(req: Request): Promise<Response> {
  try {
    const sessionId = new URL(req.url).searchParams.get('sessionId');
    if (sessionId) {
      const s = sseSessions.get(sessionId);
      if (s) {
        clearInterval(s.heartbeat);
        try {
          s.controller.close();
        } catch {
          /* already closed */
        }
        sseSessions.delete(sessionId);
      }
    }
  } catch {
    /* ignore */
  }
  return new Response(null, { status: 204 });
}

export { handlePost as POST, handleGet as GET, handleDelete as DELETE };
