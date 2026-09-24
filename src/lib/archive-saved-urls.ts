import { supabaseAdmin } from '@/lib/supabase-admin';
import { pageIdentity } from '@/lib/archive-placement';

export type SavedArchiveHit = {
  pageId: string;
  htmlUrl: string;
  name: string;
};

const URL_SELECT = [
  'id',
  'name',
  ...Array.from({ length: 12 }, (_, i) => `u${i}:steps->${i}->>url_to_swipe`),
  ...Array.from({ length: 12 }, (_, i) => `s${i}:steps->${i}->cloned_data->>source_url`),
  ...Array.from({ length: 12 }, (_, i) => `p${i}:steps->${i}->>page_id`),
  ...Array.from({ length: 12 }, (_, i) => `h${i}:steps->${i}->cloned_data->>htmlUrl`),
].join(', ');

function addHit(
  map: Map<string, SavedArchiveHit>,
  rawUrl: string,
  hit: SavedArchiveHit,
) {
  const id = pageIdentity(rawUrl);
  if (id && !map.has(id)) map.set(id, hit);
}

export async function listSavedArchiveHits(
  userId: string,
  projectId: string | null,
): Promise<Map<string, SavedArchiveHit>> {
  const map = new Map<string, SavedArchiveHit>();
  const pageSize = 200;
  for (let from = 0; from < 4000; from += pageSize) {
    let q = supabaseAdmin
      .from('archived_funnels')
      .select(URL_SELECT)
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
    const { data, error } = await q;
    if (error) {
      console.warn('[archive-saved-urls]', error.message);
      break;
    }
    const rows = data || [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const funnelId = String(r.id || '');
      const name = String(r.name || '');
      for (let i = 0; i < 12; i++) {
        const url = String(r[`u${i}`] || r[`s${i}`] || '');
        if (!url) continue;
        addHit(map, url, {
          pageId: String(r[`p${i}`] || funnelId),
          htmlUrl: String(r[`h${i}`] || ''),
          name,
        });
      }
    }
    if (rows.length < pageSize) break;
  }
  return map;
}

export async function findSavedArchivePage(
  userId: string,
  url: string,
  projectId: string | null,
): Promise<SavedArchiveHit | null> {
  const want = pageIdentity(url);
  if (!want) return null;
  const hits = await listSavedArchiveHits(userId, projectId);
  return hits.get(want) || null;
}
