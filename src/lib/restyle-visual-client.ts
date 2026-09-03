import {
  applyPaintedMedia,
  applyPalette,
  collectRestyleSlots,
  fallbackPalette,
  injectRestyleMediaScript,
  replaceMediaUrl,
  type PaintedMedia,
} from '@/lib/restyle-slots';
import {
  isLandingSection,
  matchLandingMediaToSlots,
  type LandingMediaItem,
  type LandingSection,
} from '@/lib/landing-media';

type LandingMediaResponse = LandingMediaItem[] | { items?: LandingMediaItem[]; error?: string };

async function loadLandingLibrary(projectId: string): Promise<LandingMediaItem[]> {
  const get = await fetch(`/api/projecthub/projects/${projectId}/landing-media`);
  const first = (await get.json().catch(() => [])) as LandingMediaResponse;
  let items = Array.isArray(first) ? first : first.items || [];
  if (items.length) return items;

  const post = await fetch(`/api/projecthub/projects/${projectId}/landing-media`, { method: 'POST' });
  const extracted = (await post.json().catch(() => ({}))) as LandingMediaResponse & { error?: string };
  if (!post.ok) throw new Error(extracted.error || `Landing library HTTP ${post.status}`);
  items = Array.isArray(extracted) ? extracted : extracted.items || [];
  return items;
}

function asSection(raw: string): LandingSection {
  return isLandingSection(raw) ? raw : 'other';
}

export async function runVisualRestyle(opts: {
  html: string;
  productName: string;
  brief?: string;
  research?: string;
  description?: string;
  projectId?: string;
  pageUrl?: string;
  onProgress?: (message: string, html?: string) => void;
}): Promise<{ html: string; replaced: number; total: number; failed: number; error?: string }> {
  const palette0 = fallbackPalette(opts.productName, `${opts.brief || ''} ${opts.description || ''}`);
  let html = applyPalette(opts.html, palette0);
  opts.onProgress?.('Palette on — loading competitor landing photos…', html);

  const slots = collectRestyleSlots(opts.html, 24, opts.pageUrl || '');
  if (!slots.length) {
    return { html, replaced: 0, total: 0, failed: 0, error: 'No photos/GIFs/videos on the page' };
  }

  if (!opts.projectId) {
    return { html, replaced: 0, total: slots.length, failed: slots.length, error: 'No project — cannot load landing photos' };
  }

  let library: LandingMediaItem[] = [];
  try {
    library = await loadLandingLibrary(opts.projectId);
  } catch (e) {
    return { html, replaced: 0, total: slots.length, failed: slots.length, error: (e as Error).message };
  }

  const alreadyOnPage = new Set(slots.map((s) => s.src));
  const usable = library.filter((m) => m.storedUrl && !alreadyOnPage.has(m.sourceUrl));
  const pool = usable.length ? usable : library.filter((m) => m.storedUrl);
  const stills = pool.filter((m) => m.kind === 'image' || m.kind === 'gif');
  const videos = pool.filter((m) => m.kind === 'video');

  if (!stills.length && !videos.length) {
    return {
      html,
      replaced: 0,
      total: slots.length,
      failed: slots.length,
      error: 'No photos in the project landing library. Save competitor landings first.',
    };
  }

  opts.onProgress?.(
    `Library: ${stills.length} photos / ${videos.length} videos — placing on the page…`,
    html,
  );

  const used = new Set<string>();
  const imgSlots = slots
    .filter((s) => s.kind !== 'video')
    .map((s) => ({ ...s, section: asSection(s.section) }));
  const videoSlots = slots
    .filter((s) => s.kind === 'video')
    .map((s) => ({ ...s, section: asSection(s.section || 'video') }));

  const paints: PaintedMedia[] = [];
  let replaced = 0;

  for (const { slot, item } of matchLandingMediaToSlots(imgSlots, stills, used)) {
    if (!item?.storedUrl) continue;
    if (typeof slot.domIndex === 'number') {
      paints.push({ tag: slot.domTag === 'video' ? 'video' : 'img', index: slot.domIndex, url: item.storedUrl });
    }
    html = replaceMediaUrl(html, slot.src, item.storedUrl, opts.pageUrl);
    replaced++;
  }
  for (const { slot, item } of matchLandingMediaToSlots(videoSlots, videos, used)) {
    if (!item?.storedUrl) continue;
    if (typeof slot.domIndex === 'number') {
      paints.push({ tag: 'video', index: slot.domIndex, url: item.storedUrl });
    }
    html = replaceMediaUrl(html, slot.src, item.storedUrl, opts.pageUrl);
    replaced++;
  }

  if (paints.length) html = applyPaintedMedia(html, paints);
  if (paints.length) html = injectRestyleMediaScript(html, paints);

  opts.onProgress?.(
    replaced
      ? `Placed ${replaced} competitor landing photos`
      : 'Library loaded but no slot matched',
    html,
  );

  return {
    html,
    replaced,
    total: slots.length,
    failed: Math.max(0, slots.length - replaced),
    error: replaced ? undefined : 'Landing photos did not match any slot on the page',
  };
}
