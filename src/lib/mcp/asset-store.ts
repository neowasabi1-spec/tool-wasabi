/**
 * Asset store for the MCP server.
 *
 * A "clone" produces a large HTML string that we must NOT ship back to the
 * user's Claude (huge, expensive, useless as raw context). Instead we persist
 * it under a short `assetId` and only hand Claude the id + metadata. Later
 * tools (`extract_texts`, `apply_rewrites`) look the asset back up by id.
 *
 * Backing store:
 *   - Netlify Blobs when running on Netlify (persists across function
 *     invocations, which is required because each MCP tool call is a
 *     separate serverless invocation).
 *   - An in-process Map fallback for plain `next dev` (single process, non
 *     persistent) so local development works without `netlify dev`.
 */

export interface McpAsset {
  id: string;
  ownerId: string;
  sourceUrl: string;
  title: string;
  html: string;
  /** Extracted texts, populated by `extract_texts`. */
  texts?: Array<{ id: number; original: string; tag: string }>;
  /** Final rewritten HTML, populated by `apply_rewrites`. */
  resultHtml?: string;
  createdAt: number;
  updatedAt: number;
}

const STORE_NAME = 'mcp-assets';

// In-process fallback (dev only).
const memory = new Map<string, McpAsset>();

type NetlifyStore = {
  get: (key: string, opts?: { type?: 'json' | 'text' }) => Promise<unknown>;
  setJSON: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

async function getBlobStore(): Promise<NetlifyStore | null> {
  try {
    // Imported lazily so plain `next dev` (no Netlify runtime) doesn't crash
    // at module load if the package can't initialise.
    const mod = await import('@netlify/blobs');
    return mod.getStore(STORE_NAME) as unknown as NetlifyStore;
  } catch {
    return null;
  }
}

export function newAssetId(): string {
  // Short, URL-safe, collision-resistant enough for this use.
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

export async function saveAsset(asset: McpAsset): Promise<void> {
  asset.updatedAt = Date.now();
  const store = await getBlobStore();
  if (store) {
    await store.setJSON(asset.id, asset);
    return;
  }
  memory.set(asset.id, asset);
}

export async function getAsset(id: string): Promise<McpAsset | null> {
  const store = await getBlobStore();
  if (store) {
    const val = (await store.get(id, { type: 'json' })) as McpAsset | null;
    return val ?? null;
  }
  return memory.get(id) ?? null;
}

export async function updateAsset(
  id: string,
  patch: Partial<McpAsset>,
): Promise<McpAsset | null> {
  const existing = await getAsset(id);
  if (!existing) return null;
  const merged: McpAsset = { ...existing, ...patch, id, updatedAt: Date.now() };
  await saveAsset(merged);
  return merged;
}
