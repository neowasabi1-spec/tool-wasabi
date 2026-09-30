/**
 * Meta Ad Library URL builders for Apify spy runs.
 */

/** Map a free-text market/language hint to an ISO country code. Defaults to US. */
export function countryFromMarketHint(...parts: Array<string | null | undefined>): string {
  const s = parts.filter(Boolean).join(' ').toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/german|deutsch|tedesc|germani|\bde\b/, 'DE'],
    [/franc|french|français|\bfr\b/, 'FR'],
    [/spa(gn|in|ño)|espa|\bes\b/, 'ES'],
    [/portug|\bpt\b|brasil|brazil/, 'PT'],
    [/nederl|dutch|holland|\bnl\b/, 'NL'],
    [/united states|\busa\b|\bus\b|america|english/, 'US'],
    [/united kingdom|\buk\b|england|britain/, 'GB'],
    [/ital|\bit\b/, 'IT'],
  ];
  for (const [re, cc] of table) if (re.test(s)) return cc;
  return 'US';
}

/** Keyword search URL used by Chimera discovery and vertical-peer spy. */
export function fbAdLibrarySearchUrl(keyword: string, country = 'US'): string {
  const q = encodeURIComponent(keyword.trim());
  // keyword_exact: the phrase must appear. keyword_unordered matches ANY
  // word ("coffee" → coffee shops, machines, grocery).
  const cc = (country || 'US').trim().toUpperCase() || 'US';
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${cc}&q=${q}&search_type=keyword_exact&media_type=all`;
}
