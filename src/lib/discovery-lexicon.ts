/**
 * Competitor-discovery include/exclude terms. Stored on the project so the
 * Apify webhook URL stays short (Apify caps requestUrl at 500 chars).
 */

const BUCKET = 'project-files';

export function lexiconObjectKey(projectId: string): string {
  return `${projectId}/chimera/discovery-lexicon.json`;
}

export async function saveDiscoveryLexicon(
  sb: { storage: { from: (b: string) => { upload: Function; remove: Function } } },
  projectId: string,
  include: string[],
  exclude: string[],
): Promise<void> {
  const key = lexiconObjectKey(projectId);
  const body = JSON.stringify({ include, exclude, savedAt: new Date().toISOString() });
  const bucket = sb.storage.from(BUCKET);
  await bucket.remove([key]).catch(() => {});
  const { error } = await bucket.upload(key, Buffer.from(body, 'utf-8'), {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw new Error(`discovery lexicon: ${error.message}`);
}

export async function loadDiscoveryLexicon(
  sb: { storage: { from: (b: string) => { download: Function } } },
  projectId: string,
): Promise<{ include: string[]; exclude: string[] }> {
  const { data, error } = await sb.storage.from(BUCKET).download(lexiconObjectKey(projectId));
  if (error || !data) return { include: [], exclude: [] };
  try {
    const text = await (data as Blob).text();
    const obj = JSON.parse(text) as { include?: unknown; exclude?: unknown };
    return {
      include: Array.isArray(obj.include) ? obj.include.map(String) : [],
      exclude: Array.isArray(obj.exclude) ? obj.exclude.map(String) : [],
    };
  } catch {
    return { include: [], exclude: [] };
  }
}

/** Apify rejects webhook URLs longer than 500 chars. Keep only ids + a short key. */
export function shortApifyWebhookUrl(opts: {
  base: string;
  projectId: string;
  platform?: string;
  brandId?: string | number;
  secret?: string;
}): string {
  const params = new URLSearchParams({ p: opts.projectId });
  if (opts.platform) params.set('t', opts.platform);
  if (opts.brandId != null && String(opts.brandId)) params.set('b', String(opts.brandId));
  const key = (opts.secret || '').trim();
  if (key) params.set('k', key.slice(0, 12));
  return `${opts.base.replace(/\/$/, '')}/api/apify/webhook?${params.toString()}`;
}

export function webhookKeyMatches(provided: string, expected: string): boolean {
  if (!expected) return true;
  if (!provided) return false;
  return provided === expected || provided === expected.slice(0, 12);
}
