/**
 * Per-step offer (price, brief, packshot) for Clone/Swipe.
 *
 * Manual: each Product Brief tab can have its own price, uploaded brief, and
 * mockups. Chimera: frontend price + generated packshots named
 * "Product — …" / "Upsell N — …". Swipe must use THIS step's offer, not
 * invent prices or reuse the first page's photo/palette for the whole funnel.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { derivedProductBriefSections, type ProductBriefSection } from '@/lib/projecthub-legacy';
import { extractSectionContent } from '@/lib/project-sections';
import { normalizeArchiveType } from '@/types';
import type { LandingMediaItem } from '@/lib/landing-media';

const PROJECT_FILES_BUCKET = 'project-files';

export type StepOffer = {
  sectionId: string | null;
  price: string;
  brief: string;
  imageUrl: string;
  imageUrls: string[];
};

const LANDINGISH =
  /^(landing|advertorial|vsl|bridge|pre_?sell|opt|quiz|lead|squeeze|sales|front)/i;

type FileRow = {
  file_type: string;
  file_path: string;
  original_name?: string | null;
  created_at?: string | null;
};

function publicUrl(sb: SupabaseClient, path: string): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return sb.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(path).data?.publicUrl || '';
}

export function knownPriceBlock(price: string | undefined | null): string {
  const t = String(price || '').trim();
  if (!t) return '';
  return `PRODUCT PRICE (use this exact price in every offer, bundle and checkout line — do not invent another): ${t}`;
}

function isLandingish(pageType: string): boolean {
  const t = normalizeArchiveType(pageType);
  return t === 'altro' || LANDINGISH.test(t);
}

function nameMatchesPage(originalName: string, pageType: string): boolean {
  const want = normalizeArchiveType(pageType);
  const n = String(originalName || '');
  const numbered = want.match(/^(upsell|downsell)_(\d+)$/);
  if (numbered) return new RegExp(`${numbered[1]}\\s*${numbered[2]}\\b`, 'i').test(n);
  if (/downsell/.test(want)) return /downsell/i.test(n);
  if (/bump/.test(want)) return /bump/i.test(n);
  if (/oto/.test(want)) return /\boto\b|one[-_ ]?time/i.test(n);
  if (isLandingish(pageType)) return !/upsell|downsell|\boto\b/i.test(n);
  return false;
}

function pickSection(
  sections: ProductBriefSection[],
  pageType: string,
  pageName: string,
): ProductBriefSection | null {
  if (!sections.length) return null;
  const want = normalizeArchiveType(pageType);
  const byType = sections.find((s) => s.pageType && normalizeArchiveType(s.pageType) === want);
  if (byType) return byType;

  const numbered = want.match(/^(upsell|downsell)_(\d+)$/);
  if (numbered) {
    const re = new RegExp(`${numbered[1]}\\s*${numbered[2]}\\b`, 'i');
    const byLabel = sections.find((s) => re.test(s.label) || re.test(s.pageType || ''));
    if (byLabel) return byLabel;
  }

  const blob = `${pageName} ${pageType}`.toLowerCase();
  const fuzzy = sections.find((s) => s.label && blob.includes(s.label.toLowerCase()) && s.label.length > 3);
  if (fuzzy) return fuzzy;

  if (isLandingish(pageType)) {
    return sections.find((s) => s.id === 'pb_frontend') || sections[0] || null;
  }
  return null;
}

function newestFirst(a: FileRow, b: FileRow): number {
  return String(b.created_at || '').localeCompare(String(a.created_at || ''));
}

export async function loadStepOffer(
  sb: SupabaseClient,
  projectId: string,
  pageType: string,
  pageName = '',
): Promise<StepOffer> {
  const empty: StepOffer = { sectionId: null, price: '', brief: '', imageUrl: '', imageUrls: [] };
  if (!projectId) return empty;

  let { data: project, error } = await sb
    .from('projects')
    .select('product_brief_sections, brief, brief_files, description')
    .eq('id', projectId)
    .single();
  if (error && /product_brief_sections|brief_files/i.test(error.message || '')) {
    const retry = await sb.from('projects').select('brief, description').eq('id', projectId).single();
    project = retry.data;
  }

  const sections = derivedProductBriefSections((project || {}) as Record<string, unknown>);
  const section = pickSection(sections, pageType, pageName);
  const frontend = sections.find((s) => s.id === 'pb_frontend') || null;
  const projectBrief = extractSectionContent(
    (project as { brief_files?: unknown } | null)?.brief_files,
  ).trim() || extractSectionContent(project?.brief).trim();

  const { data: fileRows } = await sb
    .from('project_files')
    .select('file_type, file_path, original_name, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200);
  const files = ((fileRows || []) as FileRow[]).slice().sort(newestFirst);

  const mockups = section
    ? files.filter((f) => f.file_type === `img_${section.id}` && f.file_path)
    : [];
  const namedPackshots = files.filter(
    (f) => f.file_type === 'product_image' && nameMatchesPage(f.original_name || '', pageType),
  );
  const ugc = files.filter((f) => f.file_type === 'ugc' && f.file_path);
  const mainPackshots = files.filter(
    (f) => f.file_type === 'product_image' && !/upsell|downsell|\boto\b/i.test(f.original_name || ''),
  );

  let imageUrls: string[] = [];
  const push = (rows: FileRow[]) => {
    for (const f of rows) {
      const url = publicUrl(sb, f.file_path);
      if (url && !imageUrls.includes(url)) imageUrls.push(url);
    }
  };
  push(mockups);
  if (!imageUrls.length) push(namedPackshots);
  if (!imageUrls.length && isLandingish(pageType)) {
    push(ugc);
    push(mainPackshots);
  }

  const fromSection = String(section?.briefText || '').trim();
  const brief = fromSection
    || (section?.id === 'pb_frontend' || isLandingish(pageType) ? projectBrief : '')
    || '';

  const price = String(section?.price || '').trim()
    || (isLandingish(pageType) ? String(frontend?.price || '').trim() : '')
    || '';

  return {
    sectionId: section?.id || null,
    price,
    brief,
    imageUrl: imageUrls[0] || '',
    imageUrls: imageUrls.slice(0, 8),
  };
}

export function stepOfferToMediaItems(offer: StepOffer): LandingMediaItem[] {
  return offer.imageUrls.map((url, i) => ({
    id: `step-mock-${i}`,
    kind: 'image' as const,
    section: i === 0 ? 'product' : 'lifestyle',
    sourceUrl: url,
    storedUrl: url,
    filePath: '',
    name: `step-mock-${i}`,
    position: i,
  }));
}

export async function patchProductBriefSection(
  sb: SupabaseClient,
  projectId: string,
  sectionId: string,
  patch: Partial<Pick<ProductBriefSection, 'price' | 'briefText'>>,
): Promise<void> {
  const { data: project } = await sb
    .from('projects')
    .select('product_brief_sections, brief, brief_files, market_research, front_end, back_end, compliance_funnel, funnel')
    .eq('id', projectId)
    .single();
  const sections = derivedProductBriefSections((project || {}) as Record<string, unknown>);
  const next = sections.map((s) => {
    if (s.id !== sectionId) return s;
    const briefText = patch.briefText !== undefined
      ? [s.briefText, patch.briefText].filter(Boolean).join('\n\n').slice(0, 200_000)
      : s.briefText;
    return {
      ...s,
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      ...(patch.briefText !== undefined ? { briefText } : {}),
    };
  });
  const { error } = await sb
    .from('projects')
    .update({ product_brief_sections: JSON.stringify(next) })
    .eq('id', projectId);
  if (error) console.warn('[step-offer] patch section failed:', error.message);
}

export async function upsertFrontendPrice(
  sb: SupabaseClient,
  projectId: string,
  price: string,
): Promise<void> {
  const t = String(price || '').trim();
  if (!projectId || !t) return;
  const { data: project } = await sb
    .from('projects')
    .select('product_brief_sections')
    .eq('id', projectId)
    .single();
  const sections = derivedProductBriefSections((project || {}) as Record<string, unknown>);
  const hasFrontend = sections.some((s) => s.id === 'pb_frontend');
  const next = hasFrontend
    ? sections.map((s) => (s.id === 'pb_frontend' ? { ...s, price: t } : s))
    : [{ id: 'pb_frontend', label: 'Frontend', price: t }, ...sections];
  await sb
    .from('projects')
    .update({ product_brief_sections: JSON.stringify(next) })
    .eq('id', projectId);
}
