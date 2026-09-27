import { graphGet } from './graph';

export const AD_FIELDS = [
  'id', 'page_id', 'page_name', 'ad_creation_time', 'ad_delivery_start_time', 'ad_delivery_stop_time',
  'ad_creative_bodies', 'ad_creative_link_titles', 'ad_creative_link_descriptions', 'ad_creative_link_captions',
  'ad_snapshot_url', 'languages', 'publisher_platforms', 'target_locations',
].join(',');

/** Paesi di default: UE + USA. ad_reached_countries accetta un array di codici ISO. */
export const DEFAULT_COUNTRIES = ['US', 'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'AT', 'PL', 'SE', 'DK', 'FI', 'IE', 'PT', 'CZ', 'RO', 'GR', 'HU'];

export type LibraryAd = {
  id: string;
  page_id: string;
  page_name?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[];
  ad_snapshot_url?: string;
  languages?: string[];
  target_locations?: { name: string }[];
};

/** Tutte le ads di una pagina (attive e non), con paginazione completa. */
export async function fetchPageAds(pageId: string, opts: { countries?: string[]; max?: number; onPage?: (n: number) => void } = {}): Promise<LibraryAd[]> {
  const out: LibraryAd[] = [];
  let next: string | null = null;
  let data: any = await graphGet('ads_archive', {
    search_page_ids: JSON.stringify([pageId]),
    ad_reached_countries: JSON.stringify(opts.countries ?? DEFAULT_COUNTRIES),
    ad_active_status: 'ALL',
    ad_type: 'ALL',
    fields: AD_FIELDS,
    limit: '100',
  });
  for (;;) {
    out.push(...(data.data ?? []));
    opts.onPage?.(out.length);
    next = data.paging?.next ?? null;
    if (!next || (opts.max && out.length >= opts.max)) break;
    data = await graphGet(next, {});
  }
  return out;
}

/** Cerca pagine per nome usando la Library stessa: restituisce le pagine che hanno ads con quel termine. */
export async function searchPagesByName(name: string): Promise<{ page_id: string; page_name: string }[]> {
  const data = await graphGet('ads_archive', {
    search_terms: name,
    ad_reached_countries: JSON.stringify(DEFAULT_COUNTRIES),
    ad_active_status: 'ALL',
    fields: 'page_id,page_name',
    limit: '100',
  });
  const seen = new Map<string, string>();
  for (const a of data.data ?? []) if (a.page_id && !seen.has(a.page_id)) seen.set(a.page_id, a.page_name ?? '');
  return [...seen.entries()].map(([page_id, page_name]) => ({ page_id, page_name }));
}

/**
 * Risolve una riga incollata (URL, username, id o nome) in un page_id.
 * - numero → page_id
 * - facebook.com/profile.php?id=123 → 123
 * - facebook.com/<username> → Graph /<username>
 * - ads/library/?view_all_page_id=123 → 123
 * - altro → ricerca per nome nella Library (solo corrispondenza esatta del nome)
 */
export async function resolvePage(input: string): Promise<{ page_id: string; name: string } | { error: string }> {
  const line = input.trim();
  if (!line) return { error: 'riga vuota' };
  if (/^\d{5,}$/.test(line)) return { page_id: line, name: '' };
  try {
    if (/facebook\.com|fb\.com/i.test(line)) {
      const u = new URL(line.startsWith('http') ? line : `https://${line}`);
      const id = u.searchParams.get('id') || u.searchParams.get('view_all_page_id');
      if (id) return { page_id: id, name: '' };
      const slug = u.pathname.split('/').filter(Boolean)[0];
      if (!slug) return { error: 'URL senza pagina' };
      const idInSlug = slug.match(/-(\d{5,})$/)?.[1];
      if (idInSlug) return { page_id: idInSlug, name: slug };
      const d = await graphGet(slug, { fields: 'id,name' });
      return { page_id: d.id, name: d.name ?? slug };
    }
    const found = await searchPagesByName(line);
    const exact = found.filter((p) => p.page_name.toLowerCase() === line.toLowerCase());
    if (exact.length === 1) return { page_id: exact[0].page_id, name: exact[0].page_name };
    if (exact.length > 1) return { error: `più pagine con questo nome: ${exact.map((p) => p.page_id).join(', ')}` };
    return { error: found.length ? `nessuna corrispondenza esatta; simili: ${found.slice(0, 3).map((p) => `${p.page_name} (${p.page_id})`).join(', ')}` : 'nessuna pagina trovata' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
