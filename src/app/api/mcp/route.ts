export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP endpoint — temporarily disabled.
 *
 * The `mcp-handler` + `@modelcontextprotocol/sdk` packages are declared but not
 * present in the installed lockfile, which broke the production build. Until
 * those deps are installed (`npm install mcp-handler @modelcontextprotocol/sdk`
 * and commit the updated package-lock.json), this route returns 503 instead of
 * failing the whole build. The full handler implementation lives in git
 * history and the supporting libs (src/lib/mcp/**) remain in place.
 */
async function handle(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: 'MCP endpoint temporarily unavailable' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

export { handle as GET, handle as POST, handle as DELETE };
