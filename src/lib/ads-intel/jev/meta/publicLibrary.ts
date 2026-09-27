/** Playwright Ad Library scrape is NOT used in Wasabi — competitor ads come from Apify/extension. */

export type PublicAd = {
  library_id: string;
  impression_rank: number | null;
  start_date: string | null;
  stop_date: string | null;
  active: boolean;
  body: string;
  headline: string;
  description: string;
  caption: string;
  cta: string;
  video_url: string | null;
  poster_url: string | null;
  image_urls: string[];
  video_duration_s: number | null;
  copies: number;
  multi_version: boolean;
  eu_transparency: boolean;
  page_name: string | null;
};

export type ScrapeOpts = {
  activeStatus?: string;
  max?: number;
  onProgress?: (msg: string) => void;
};

export async function scrapePageAds(
  _pageId: string,
  _opts: ScrapeOpts = {},
): Promise<{ ads: PublicAd[]; totalLabel: string | null; pageName: string | null }> {
  throw new Error(
    'Playwright Ad Library scrape disabled in Wasabi. Use Competitor Library (Apify) then ingest_from_competitor_ad.',
  );
}

export function libraryUrl(pageId: string): string {
  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${pageId}&sort_data[direction]=desc&sort_data[mode]=total_impressions`;
}

export async function closeBrowser(): Promise<void> {}
