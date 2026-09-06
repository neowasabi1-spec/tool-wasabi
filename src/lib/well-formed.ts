/**
 * Ad copy and scraped pages are full of emoji. Slicing such text by char
 * count can split a surrogate pair, and the Anthropic API then rejects the
 * whole request body ("no low surrogate in string"). Pass every string that
 * goes into a model prompt through here.
 */
export function wellFormed(s: unknown): string {
  const str = String(s ?? '');
  const tw = (str as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof tw === 'function') return tw.call(str);
  return str
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1\uFFFD');
}

/** `slice` that never cuts an emoji in half. */
export function sliceWellFormed(s: unknown, max: number): string {
  return wellFormed(String(s ?? '').slice(0, max));
}
