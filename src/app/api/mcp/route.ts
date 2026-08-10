export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP endpoint — Streamable HTTP transport, dependency-free.
 *
 * History: this route used to depend on `mcp-handler` + `@modelcontextprotocol/sdk`.
 * Those packages were declared but never made it into the installed lockfile,
 * which broke the production build, so a previous change stubbed this route to
 * return 503 ("temporarily unavailable"). That stub is exactly why connected
 * Claude clients (Neo / Morfeo) reported "the MCP server is down".
 *
 * Rather than reintroduce the fragile external dependency, we implement the MCP
 * JSON-RPC 2.0 protocol directly here. It's a tiny surface (initialize,
 * tools/list, tools/call, ping) and it sits on top of the already-present,
 * battle-tested tool implementations in src/lib/mcp/tools.ts + the per-user
 * OAuth auth in src/lib/mcp/auth.ts. No npm install required, so the build can
 * never break on a missing MCP dependency again.
 */
import { resolveOwner, unauthorizedResponse } from '@/lib/mcp/auth';
import { mcpContext } from '@/lib/mcp/context';
import { cloneLandingPage, extractTexts, applyRewrites } from '@/lib/mcp/tools';

const PROTOCOL_VERSION = '2025-06-18';
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

async function handleRpc(
  ownerId: string,
  msg: JsonRpcRequest,
): Promise<object | null> {
  const { id, method } = msg;
  const params = (msg.params || {}) as Record<string, unknown>;

  // Notifications (no id): acknowledge without a response body.
  if (id === undefined || id === null) {
    // e.g. notifications/initialized, notifications/cancelled — nothing to do.
    return null;
  }

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
        // Tool-level failures are reported as a successful RPC with isError,
        // per MCP, so the client model can read and react to the error text.
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

async function handlePost(req: Request): Promise<Response> {
  const auth = resolveOwner(req);
  if (!auth) return unauthorizedResponse();

  let payload: unknown;
  try {
    const raw = await req.text();
    payload = raw ? JSON.parse(raw) : null;
  } catch {
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
        // If every message was a notification there is nothing to return.
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

// GET is used by the Streamable HTTP transport to open a server->client SSE
// stream. This server is stateless (request/response only) and offers no such
// stream, so per the spec we return 405.
async function handleGet(): Promise<Response> {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { allow: 'POST, DELETE' },
  });
}

// DELETE terminates a session. We are stateless, so just acknowledge.
async function handleDelete(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export { handlePost as POST, handleGet as GET, handleDelete as DELETE };
