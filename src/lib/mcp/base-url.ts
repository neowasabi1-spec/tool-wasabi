/**
 * Resolve the public base URL of this deployment, used both for:
 *   - server-to-server calls to our own existing API routes
 *     (`/api/landing/clone`, `/api/landing/swipe/openclaw-*`)
 *   - building preview URLs handed back to the user's Claude.
 *
 * Precedence:
 *   1. MCP_PUBLIC_BASE_URL   — explicit override (recommended in prod)
 *   2. URL                   — Netlify's primary site URL
 *   3. DEPLOY_PRIME_URL      — Netlify deploy-preview URL
 *   4. localhost fallback    — plain `next dev`
 */
export function getBaseUrl(): string {
  const explicit = process.env.MCP_PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const netlifyUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (netlifyUrl) return netlifyUrl.replace(/\/$/, '');
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}
