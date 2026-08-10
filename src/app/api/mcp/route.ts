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
import { resolveOwner, unauthorizedResponse } from '@/lib/mcp/auth';
import { mcpContext } from '@/lib/mcp/context';
import { cloneLandingPage, extractTexts, applyRewrites } from '@/lib/mcp/tools';

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
    const postAuth = resolveOwner(req);
    const ownerId = postAuth?.ownerId || session.ownerId;
    if (!ownerId) return unauthorizedResponse();
    if (!session.ownerId) session.ownerId = ownerId;

    const payload = await parseBody(req);
    if (payload === PARSE_ERROR) {
      return new Response('invalid json', { status: 400 });
    }
    const messages = Array.isArray(payload) ? (payload as JsonRpcRequest[]) : [payload as JsonRpcRequest];
    // Process and push each response back over the SSE channel.
    await mcpContext.run({ ownerId }, async () => {
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
  const auth = resolveOwner(req);
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

  return mcpContext.run({ ownerId: auth.ownerId }, async () => {
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
  const auth = resolveOwner(req);

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
