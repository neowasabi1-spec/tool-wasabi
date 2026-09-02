/** Client-safe encode/decode for Creative-tab copy stored in `tags`. */

export type CreativeCopy = { headline: string; hook: string; bodyText: string };

export function parseCreativeCopy(tags: string | null | undefined): CreativeCopy {
  const raw = String(tags || '').trim();
  if (!raw) return { headline: '', hook: '', bodyText: '' };
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (j && typeof j === 'object' && ('headline' in j || 'hook' in j || 'bodyText' in j || 'body' in j)) {
        return {
          headline: String(j.headline || ''),
          hook: String(j.hook || ''),
          bodyText: String(j.bodyText || j.body || ''),
        };
      }
    } catch {
      /* treat as plain body */
    }
  }
  return { headline: '', hook: '', bodyText: raw };
}

export function encodeCreativeCopy(copy: Partial<CreativeCopy>): string {
  const headline = String(copy.headline || '').trim();
  const hook = String(copy.hook || '').trim();
  const bodyText = String(copy.bodyText || '').trim();
  if (!headline && !hook && !bodyText) return '';
  return JSON.stringify({ headline, hook, bodyText });
}

export function displayCreativeCopy(tags: string | null | undefined): string {
  const c = parseCreativeCopy(tags);
  return [c.headline, c.hook, c.bodyText].filter(Boolean).join('\n\n');
}
