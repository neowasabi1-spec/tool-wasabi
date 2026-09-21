/** Pack-count + container language for swipe/restyle. Safe to import from the client. */

const UNIT_RE =
  /\b(\d+)\s*[x×]?\s*(bottles?|jars?|tubs?|tubs?|canisters?|pouches?|sachets?|sticks?|packs?|units?|bottiglie|barattoli|flacone?i?|vasetti|bustine)\b/i;
const BARE_PACK_RE = /\b(\d+)\s*[x×]\s*(pack|bottles?|jars?)?\b/i;

export function parsePackQty(text: string): number | null {
  const blob = String(text || '');
  const m = blob.match(UNIT_RE) || blob.match(BARE_PACK_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 2 || n > 24) return null;
  return n;
}

export function looksLikeProductPackSlot(text: string): boolean {
  return /product|packshot|packaging|mockup|bottle|jar|tub|pouch|sachet|stick|box|pack\b|confezione|prodotto|sku|flacone|barattolo|holding (the )?product/i
    .test(String(text || ''));
}

/** Image-to-image prompt: keep the original pack layout, swap in our product. */
export function packSwipePrompt(opts: {
  productName: string;
  nearby?: string;
  qty?: number | null;
}): string {
  const qty = opts.qty;
  const countLine = qty
    ? `The original shows a ${qty}-unit pack. Output exactly ${qty} units of our product.`
    : 'Count the units in the FIRST image and output that exact count of our product (2 stays 2, 6 stays 6, 3 stays 3, 1 stays 1).';
  const nearby = String(opts.nearby || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return [
    `Recreate this commercial packshot for "${opts.productName}".`,
    'FIRST image = original competitor photo: copy its LAYOUT only (camera, grouping, spacing, background, + sign if present, how units are stacked).',
    'SECOND image = our exact product. Every unit in the output must be THIS product (same container, label, colors). Do not invent a different SKU, colorway, or bottle if ours is a jar.',
    countLine,
    nearby ? `Nearby offer copy: "${nearby}".` : '',
    'Photorealistic studio packshot. No new prices, no extra text overlay, no lifestyle scene.',
  ].filter(Boolean).join(' ');
}
