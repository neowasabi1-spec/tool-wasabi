/**
 * MCP authentication.
 *
 * PRIMARY (per-user): validates a per-user OAuth access token minted by our
 * own authorization server (see src/lib/mcp/oauth/*). Each user connects
 * their OWN Claude, logs in with their OWN account on this tool, and Claude
 * receives a token bound to their Supabase user id. `ownerId` = that user.
 *
 * FALLBACK (internal testing only): a shared `MCP_DEV_TOKEN`, useful to
 * exercise the tools without going through the browser OAuth dance. Leave it
 * unset in production so only real per-user tokens are accepted.
 */
import { verifyAccessToken } from '@/lib/mcp/oauth/jwt';
import { oauthConfig } from '@/lib/mcp/oauth/config';

export interface ResolvedAuth {
  ownerId: string;
}

function extractBearer(req: Request): string {
  const header = req.headers.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/**
 * @returns the resolved owner, or `null` when the request is unauthenticated.
 */
export function resolveOwner(req: Request): ResolvedAuth | null {
  const bearer = extractBearer(req);
  if (!bearer) return null;

  // 1) Per-user OAuth access token (the real path).
  const claims = verifyAccessToken(bearer);
  if (claims?.sub) {
    return { ownerId: `sb:${claims.sub}` };
  }

  // 2) Optional shared dev token for internal testing.
  const devToken = process.env.MCP_DEV_TOKEN?.trim();
  if (devToken && bearer === devToken) {
    const userHint = req.headers.get('x-mcp-user')?.trim();
    return { ownerId: userHint ? `u:${userHint}` : 'shared-token-user' };
  }

  return null;
}

/**
 * 401 that points MCP clients at our OAuth discovery document, per RFC 9728.
 * This is what triggers Claude to start the "connect your own Claude" flow.
 */
export function unauthorizedResponse(): Response {
  let resourceMetadata = '/.well-known/oauth-protected-resource';
  try {
    resourceMetadata = oauthConfig().protectedResourceMetadataUrl;
  } catch {
    /* fall back to relative path */
  }
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'Authentication required.' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
      },
    },
  );
}
