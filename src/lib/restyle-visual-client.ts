import {
  applyPaintedMedia,
  applyPalette,
  collectRestyleSlots,
  expandPaletteMap,
  fallbackPalette,
  injectRestyleMediaScript,
  libraryFileLabel,
  paintFor,
  sealPaintedHtml,
  topSaturatedHex,
  type PaintedMedia,
  type Palette,
  type PaletteMap,
} from '@/lib/restyle-slots';
import {
  pickOfferLandingMedia,
  type LandingMediaItem,
} from '@/lib/landing-media';
import { fillLandingLibrary, landingFillError } from '@/lib/landing-media-client';

type PlaceAssignment = {
  slotId: number;
  mediaId: string | null;
  generate: boolean;
  prompt: string;
};

function pinStoredUrl(url: string): string {
  const t = String(url || '').trim();
  if (!t || /^https?:\/\//i.test(t) || typeof window === 'undefined') return t;
  return t.startsWith('/') ? `${window.location.origin}${t}` : t;
}

async function designPalette(opts: {
  html: string;
  productName: string;
  brief?: string;
  description?: string;
  projectId?: string;
  productImageUrl?: string;
}): Promise<{ palette: Palette; map: PaletteMap; fromAi: boolean }> {
  const colors = topSaturatedHex(opts.html);
  try {
    const res = await fetch('/api/restyle-visual/palette', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: opts.productName,
        brief: opts.brief,
        description: opts.description,
        projectId: opts.projectId,
        productImageUrl: opts.productImageUrl || undefined,
        colors,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { palette?: Palette; map?: PaletteMap };
    if (res.ok && data.palette?.primary) {
      return { palette: data.palette, map: Array.isArray(data.map) ? data.map : [], fromAi: true };
    }
  } catch {
    /* fall through */
  }
  return { palette: fallbackPalette(), map: [], fromAi: false };
}

async function loadLandingLibrary(projectId: string): Promise<LandingMediaItem[]> {
  const filled = await fillLandingLibrary(projectId);
  if (filled.items.length) return filled.items;
  throw new Error(landingFillError(filled) || 'No photos in the project landing library');
}

export async function runVisualRestyle(opts: {
  html: string;
  productName: string;
  brief?: string;
  research?: string;
  description?: string;
  projectId?: string;
  pageUrl?: string;
  productImageUrl?: string;
  extraImageUrls?: string[];
  onProgress?: (message: string, html?: string) => void;
}): Promise<{ html: string; replaced: number; total: number; failed: number; error?: string }> {
  opts.onProgress?.('AI is designing the colour palette from the product…');
  const designed = await designPalette(opts);
  const map = expandPaletteMap(topSaturatedHex(opts.html), designed.palette, designed.map);
  let html = applyPalette(opts.html, designed.palette, map);
  opts.onProgress?.(
    designed.fromAi ? 'Palette on — collecting the photos on the page…' : 'Neutral palette (AI palette failed) — collecting photos…',
    html,
  );

  const slots = collectRestyleSlots(html, 40, opts.pageUrl || '');
  if (!slots.length) {
    return { html, replaced: 0, total: 0, failed: 0, error: 'No photos/GIFs/videos on the page' };
  }

  if (!opts.projectId) {
    return { html, replaced: 0, total: slots.length, failed: slots.length, error: 'No project — cannot load landing photos' };
  }

  let library: LandingMediaItem[] = [];
  try {
    library = await loadLandingLibrary(opts.projectId);
  } catch {
    library = [];
  }

  let fromThisOffer = pickOfferLandingMedia(library, opts.productName);
  if (!fromThisOffer.length && opts.html) {
    try {
      const post = await fetch(`/api/projecthub/projects/${opts.projectId}/landing-media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: opts.html, pageUrl: opts.pageUrl || '' }),
      });
      const data = (await post.json().catch(() => ({}))) as { items?: LandingMediaItem[] };
      fromThisOffer = pickOfferLandingMedia(
        Array.isArray(data.items) ? data.items : [],
        opts.productName,
      );
    } catch {
      /* keep empty */
    }
  }
  const extraStills: LandingMediaItem[] = (opts.extraImageUrls || [])
    .filter((u) => /^https?:\/\//i.test(u))
    .map((url, i) => ({
      id: `step-mock-${i}`,
      kind: 'image' as const,
      section: i === 0 ? 'product' : 'lifestyle',
      sourceUrl: url,
      storedUrl: url,
      filePath: '',
      name: `step-mock-${i}`,
      position: i,
    }));
  if (extraStills.length) fromThisOffer = [...extraStills, ...fromThisOffer];

  const alreadyOnPage = new Set(slots.map((s) => s.src));
  const usable = fromThisOffer.filter((m) => {
    if (alreadyOnPage.has(m.storedUrl)) return false;
    if (String(m.id).startsWith('step-mock-')) return true;
    return m.storedUrl !== m.sourceUrl;
  });
  const pool = usable.length ? usable : fromThisOffer;
  const stills = pool.filter((m) => m.kind === 'image' || m.kind === 'gif');
  const videos = pool.filter((m) => m.kind === 'video');

  if (!stills.length && !videos.length) {
    return {
      html,
      replaced: 0,
      total: slots.length,
      failed: slots.length,
      error: 'No downloaded offer photos to place. Open Image landings first.',
    };
  }

  opts.onProgress?.('AI is looking at each image on the page…', html);

  const byId = new Map(pool.map((m) => [String(m.id), m]));
  let assignments: PlaceAssignment[] = [];
  try {
    const res = await fetch('/api/restyle-visual/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: opts.productName,
        brief: opts.brief,
        description: opts.description,
        pageUrl: opts.pageUrl || '',
        slots: slots.map((s) => ({
          id: s.id,
          kind: s.kind,
          context: s.context || s.alt || '',
          src: s.src,
          poster: s.poster,
          width: s.width,
          height: s.height,
        })),
        library: pool.map((m) => ({
          id: String(m.id),
          kind: m.kind,
          name: m.name || '',
          file: libraryFileLabel(m),
          filePath: m.filePath || '',
        })),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { assignments?: PlaceAssignment[] };
    assignments = Array.isArray(data.assignments) ? data.assignments : [];
  } catch {
    assignments = [];
  }

  const paints: PaintedMedia[] = [];
  let replaced = 0;

  for (const slot of slots) {
    const plan = assignments.find((a) => a.slotId === slot.id);
    let url = '';
    let fileKind = 'image';
    if (plan?.mediaId && byId.get(plan.mediaId)?.storedUrl) {
      const item = byId.get(plan.mediaId)!;
      url = pinStoredUrl(item.storedUrl);
      fileKind = item.kind;
    } else if (plan?.generate && plan.prompt) {
      try {
        const made = await fetch('/api/restyle-visual/concept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: opts.projectId,
            productName: opts.productName,
            nearbyText: slot.context || slot.alt || '',
            prompt: plan.prompt,
          }),
        });
        const data = (await made.json().catch(() => ({}))) as { url?: string };
        if (data.url) url = pinStoredUrl(data.url);
      } catch {
        /* leave the current image */
      }
    }
    const paint = paintFor(slot, url, fileKind);
    if (!paint) continue;
    paints.push(paint);
    replaced++;
  }

  if (paints.length) html = applyPaintedMedia(html, paints);
  html = sealPaintedHtml(html);
  if (paints.length) html = injectRestyleMediaScript(html, paints);

  opts.onProgress?.(
    replaced
      ? `Placed ${replaced} photos from copy (library + generated)`
      : 'AI did not match any slot',
    html,
  );

  return {
    html,
    replaced,
    total: slots.length,
    failed: Math.max(0, slots.length - replaced),
    error: replaced ? undefined : 'Could not place photos from the page copy',
  };
}
