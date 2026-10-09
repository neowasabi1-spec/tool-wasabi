/**
 * When Apify can't scrape (quota, missing key, all runs failed), Chimera still
 * has named competitors in the RMBC market-research teardown. Seed those as
 * Competitor Library brands so the project is never an empty grid.
 */

import { fbAdLibrarySearchUrl } from './ads-library-url';
import { loadProjectFileText } from './chimera-creative';

export type SeedBrand = { name: string; blurb: string; url?: string };

const SKIP_NAME = /^(competitor(s| research)?|teardown|alternatives?|claims to swipe|gaps to exploit|positioning|white space|our (brand|product)|include|exclude|search)$/i;

function fold(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanName(raw: string): string {
  return raw
    .replace(/[*_`#]+/g, '')
    .replace(/^\d+[\.\)]\s*/, '')
    .replace(/^(?:competitor|brand|alternative)\s*\d*\s*[—:\-–]\s*/i, '')
    .replace(/\s*[—–:].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plausibleName(name: string, own: string): boolean {
  if (!name || name.length < 2 || name.length > 48) return false;
  if (SKIP_NAME.test(name)) return false;
  if (own && fold(name) === fold(own)) return false;
  if (own && fold(own).includes(fold(name)) && name.length < 4) return false;
  const words = name.split(/\s+/).length;
  if (words > 6) return false;
  if (!/[A-Za-z]/.test(name)) return false;
  return true;
}

/** Pull competitor names out of RMBC section 6 (or any COMPETITOR heading). */
export function parseCompetitorsFromResearch(md: string, ownName = ''): SeedBrand[] {
  const text = String(md || '');
  if (!text.trim()) return [];
  const own = ownName.trim();
  const sectionMatch = text.match(
    /#{1,3}\s*6[\.\):]?\s*[^\n]*competitor[\s\S]*?(?=^#{1,3}\s*(?:7[\.\):]|\d+\.)|$)/im,
  ) || text.match(
    /#{1,3}\s*[^\n]*competitor research[\s\S]*?(?=^#{1,3}\s+\d)/im,
  );
  const section = sectionMatch ? sectionMatch[0] : '';
  if (!section.trim()) return [];

  const found: SeedBrand[] = [];
  const seen = new Set<string>();
  const push = (raw: string, blurb: string) => {
    const name = cleanName(raw);
    if (!plausibleName(name, own)) return;
    const k = fold(name);
    if (seen.has(k)) return;
    seen.add(k);
    found.push({ name, blurb: blurb.replace(/\s+/g, ' ').trim().slice(0, 1500) });
  };

  const byHeading = section.split(/^#{2,4}\s+/m);
  for (const block of byHeading) {
    const nl = block.indexOf('\n');
    const title = (nl >= 0 ? block.slice(0, nl) : block).trim();
    const body = (nl >= 0 ? block.slice(nl + 1) : '').trim();
    if (/competitor research|teardown|claims to swipe|gaps to exploit/i.test(title)) continue;
    push(title, body);
  }

  const bulletRe = /^\s*(?:[-*]|\d+[\.)])\s+\*\*([^*]{2,60})\*\*\s*[—:\-–]?\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = bulletRe.exec(section))) {
    push(m[1], m[2] || '');
  }
  const forEachRe = /(?:^|\n)\s*(?:For EACH|EACH):?\s*[^\n]*\n(?:[-*]\s+\*?\*?([^*\n,]{2,40}))/i;
  const each = section.match(forEachRe);
  if (each?.[1]) push(each[1], '');

  return found.slice(0, 8);
}

type Sb = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => { download: (path: string) => Promise<{ data: Blob | null }> } };
};

export async function seedCompetitorBrandsFromResearch(
  supabase: Sb,
  projectId: string,
  opts: {
    researchText?: string;
    ownName?: string;
    country?: string;
    extra?: SeedBrand[];
  } = {},
): Promise<{ inserted: number; names: string[] }> {
  let research = (opts.researchText || '').trim();
  if (!research) {
    try {
      research = await loadProjectFileText(supabase, projectId, 'market_research');
    } catch {
      research = '';
    }
  }
  if (!research) {
    try {
      research = await loadProjectFileText(supabase, projectId, 'pb_frontend');
    } catch {
      research = '';
    }
  }

  const parsed = parseCompetitorsFromResearch(research, opts.ownName);
  const extras = (opts.extra || []).filter((e) => plausibleName(e.name, opts.ownName || ''));
  const all: SeedBrand[] = [];
  const seen = new Set<string>();
  for (const b of [...extras, ...parsed]) {
    const k = fold(b.name);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(b);
  }
  if (!all.length) return { inserted: 0, names: [] };

  const { data: existing } = await supabase
    .from('competitor_brands')
    .select('id, name')
    .eq('project_id', projectId);
  const have = new Set(
    ((existing || []) as Array<{ name?: string }>).map((r) => fold(String(r.name || ''))).filter(Boolean),
  );

  const cc = (opts.country || 'US').replace(/^ALL$/i, 'US');
  const rows = all
    .filter((b) => !have.has(fold(b.name)))
    .map((b) => ({
      project_id: projectId,
      name: b.name.slice(0, 120),
      ads_library_url: b.url && /facebook\.com\/ads\/library/i.test(b.url)
        ? b.url
        : fbAdLibrarySearchUrl(b.name, cc),
      scrape_count: 20,
      frequency: 'every_7_days',
      brand_type: 'competitor',
      notes: b.url && !/facebook\.com\/ads\/library/i.test(b.url) ? b.url : '',
      creative_quality_notes: (b.blurb || 'Seeded from Chimera market research.').slice(0, 4000),
      is_active: 'true',
    }));

  if (!rows.length) return { inserted: 0, names: all.map((b) => b.name) };

  const { error } = await supabase.from('competitor_brands').insert(rows);
  if (error) {
    console.warn('[seed-competitors]', error.message);
    return { inserted: 0, names: all.map((b) => b.name) };
  }
  return { inserted: rows.length, names: rows.map((r) => r.name) };
}
