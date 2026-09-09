import { isStandaloneTemplatePage } from '@/lib/archive-placement';
import { normalizeArchiveType } from '@/types';
import type { ArchivedFunnel } from '@/types/database';

type ClonedShots = {
  html?: string;
  htmlUrl?: string | null;
  screenshotDesktopUrl?: string | null;
  screenshotMobileUrl?: string | null;
  category?: string;
};

export type ArchiveTemplatePage = {
  funnel_name: string;
  funnel_id: string;
  name: string;
  url_to_swipe: string;
  prompt: string;
  page_type: string;
  screenshotUrl: string | null;
};

function cardShotUrl(cd?: ClonedShots | null): string | null {
  return cd?.screenshotMobileUrl || cd?.screenshotDesktopUrl || null;
}

/** Standalone Templates → By Type pages, grouped by canonical page_type. */
export function listArchivePagesByType(
  archivedFunnels: ArchivedFunnel[],
  knownCustomTypes: string[] = [],
): Record<string, ArchiveTemplatePage[]> {
  const map: Record<string, ArchiveTemplatePage[]> = {};
  const all = archivedFunnels || [];
  for (const f of all) {
    if (!isStandaloneTemplatePage(f, all)) continue;
    const steps = (f.steps as {
      name?: string;
      page_type?: string;
      url_to_swipe?: string;
      prompt?: string;
      cloned_data?: ClonedShots;
      swiped_data?: { html?: string; htmlUrl?: string | null };
    }[]) || [];
    for (const s of steps) {
      const t = normalizeArchiveType(s.page_type, knownCustomTypes);
      if (!map[t]) map[t] = [];
      map[t].push({
        funnel_name: f.name,
        funnel_id: f.id,
        name: s.name || f.name,
        url_to_swipe: s.url_to_swipe || '',
        prompt: s.prompt || '',
        page_type: t,
        screenshotUrl: cardShotUrl(s.cloned_data),
      });
    }
  }
  return map;
}
