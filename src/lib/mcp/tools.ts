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
import { getBaseUrl } from './base-url';
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
