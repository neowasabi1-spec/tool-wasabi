export function parseAdTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw || '').split(/[,;\n]+/)) {
    const tag = part.trim().replace(/^#/, '').slice(0, 40);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

export function formatAdTags(tags: string[]): string {
  return parseAdTags(tags.join(', ')).join(', ');
}

export function adMatchesQuery(ad: { name?: string; headline?: string; tags?: string; category?: string }, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  if (String(ad.name || '').toLowerCase().includes(needle)) return true;
  if (String(ad.headline || '').toLowerCase().includes(needle)) return true;
  if (String(ad.category || '').toLowerCase().includes(needle)) return true;
  return parseAdTags(ad.tags || '').some((t) => t.toLowerCase().includes(needle));
}
