/**
 * Competitor-discovery include/exclude terms. Stored on the project so the
 * Apify webhook URL stays short (Apify caps requestUrl at 500 chars).
 */

const BUCKET = 'project-files';

export function lexiconObjectKey(projectId: string): string {
  return `${projectId}/chimera/discovery-lexicon.json`;
}

export type StoredProductProfile = {
  name: string;
  description?: string;
  market?: string;
  /** Affiliate run: the library holds the promoted offer's photos only —
   *  competitor landings are saved for research but their media is not pulled in. */
  affiliate?: boolean;
  /** Affiliate: the domains the offer lives on (tracker + final landing). */
  hosts?: string[];
};

export async function saveDiscoveryLexicon(
  sb: { storage: { from: (b: string) => { upload: Function; remove: Function } } },
  projectId: string,
  include: string[],
  exclude: string[],
  product?: StoredProductProfile,
): Promise<void> {
  const key = lexiconObjectKey(projectId);
  const body = JSON.stringify({ include, exclude, product: product || null, savedAt: new Date().toISOString() });
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
): Promise<{ include: string[]; exclude: string[]; product: StoredProductProfile | null }> {
  const { data, error } = await sb.storage.from(BUCKET).download(lexiconObjectKey(projectId));
  if (error || !data) return { include: [], exclude: [], product: null };
  try {
    const text = await (data as Blob).text();
    const obj = JSON.parse(text) as { include?: unknown; exclude?: unknown; product?: unknown };
    const p = obj.product && typeof obj.product === 'object' ? (obj.product as Record<string, unknown>) : null;
    const product = p && typeof p.name === 'string' && p.name.trim()
      ? {
          name: p.name,
          description: typeof p.description === 'string' ? p.description : '',
          market: typeof p.market === 'string' ? p.market : '',
          affiliate: p.affiliate === true,
          hosts: Array.isArray(p.hosts) ? p.hosts.map(String).filter(Boolean) : [],
        }
      : null;
    return {
      include: Array.isArray(obj.include) ? obj.include.map(String) : [],
      exclude: Array.isArray(obj.exclude) ? obj.exclude.map(String) : [],
      product,
    };
  } catch {
    return { include: [], exclude: [], product: null };
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
