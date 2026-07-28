import { supabaseAdmin } from './supabase-admin';

/**
 * "New creatives" bookkeeping for the Competitor Library.
 *
 * The daily scrape keeps adding creatives, so each brand carries the moment its
 * creatives were last looked at (competitor_brands.last_viewed_at). Anything
 * created after that is new, which is all the UI needs to badge a folder with a
 * count and mark individual cards.
 *
 * The column arrives with supabase-migration-competitor-new-badge.sql. Until
 * that migration is applied every helper here degrades to "nothing is new"
 * rather than failing the request.
 */

const MISSING_COLUMN = /column .*last_viewed_at.* does not exist|last_viewed_at/i;

/** Brand id → moment its creatives were last seen. Null when unavailable. */
export async function loadSeenAt(projectId: string): Promise<Map<number, number> | null> {
  const { data, error } = await supabaseAdmin
    .from('competitor_brands')
    .select('id, last_viewed_at')
    .eq('project_id', projectId);

  if (error) {
    if (!MISSING_COLUMN.test(error.message)) {
      console.error('[competitor-seen] could not load last_viewed_at:', error.message);
    }
    return null;
  }

  const seen = new Map<number, number>();
  for (const row of (data || []) as { id: number; last_viewed_at: string | null }[]) {
    const t = row.last_viewed_at ? new Date(row.last_viewed_at).getTime() : NaN;
    if (Number.isFinite(t)) seen.set(row.id, t);
  }
  return seen;
}

/** Was this creative added after its brand was last looked at? */
export function isNewAd(
  seen: Map<number, number> | null,
  brandId: number,
  createdAt: string | null | undefined,
): boolean {
  if (!seen) return false;
  const seenAt = seen.get(brandId);
  if (seenAt === undefined) return false;
  const created = createdAt ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(created) && created > seenAt;
}

/** Tag each creative with is_new, leaving the rest of the row untouched. */
export function tagNewAds<T extends { brand_id: number; created_at?: string | null }>(
  ads: T[],
  seen: Map<number, number> | null,
): (T & { is_new: boolean })[] {
  return ads.map((a) => ({ ...a, is_new: isNewAd(seen, a.brand_id, a.created_at) }));
}

/** Stamp a brand as looked at now, so its creatives stop counting as new. */
export async function markBrandSeen(projectId: string, brandId: number): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('competitor_brands')
    .update({ last_viewed_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('id', brandId);

  if (error) {
    if (!MISSING_COLUMN.test(error.message)) {
      console.error('[competitor-seen] could not mark brand seen:', error.message);
    }
    return false;
  }
  return true;
}
