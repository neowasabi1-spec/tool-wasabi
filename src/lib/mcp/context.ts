import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context carried across the MCP handler's async work so tool
 * callbacks know WHICH authenticated user is invoking them (needed for asset
 * ownership). Set once in the route wrapper, read inside each tool.
 */
export interface McpRequestContext {
  ownerId: string;
  /**
   * The raw `fsk_` API key from the incoming MCP request, forwarded so tools
   * that reuse the key-authed `/api/v1/*` routes (projects, archive,
   * templates, funnels) can authenticate the internal call as the same user.
   * Empty for OAuth/dev-token owners (those callers can't use v1 routes).
   */
  apiKey?: string;
}

export const mcpContext = new AsyncLocalStorage<McpRequestContext>();

export function currentOwnerId(): string {
  return mcpContext.getStore()?.ownerId ?? 'anonymous';
}

export function currentApiKey(): string {
  return mcpContext.getStore()?.apiKey ?? '';
}
