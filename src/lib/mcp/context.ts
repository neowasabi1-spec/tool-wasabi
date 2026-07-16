import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context carried across the MCP handler's async work so tool
 * callbacks know WHICH authenticated user is invoking them (needed for asset
 * ownership). Set once in the route wrapper, read inside each tool.
 */
export interface McpRequestContext {
  ownerId: string;
}

export const mcpContext = new AsyncLocalStorage<McpRequestContext>();

export function currentOwnerId(): string {
  return mcpContext.getStore()?.ownerId ?? 'anonymous';
}
