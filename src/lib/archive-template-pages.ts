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
  htmlUrl: string | null;
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
        htmlUrl:
          s.cloned_data?.htmlUrl ||
          s.swiped_data?.htmlUrl ||
          `/api/funnel-html?pageId=${encodeURIComponent(f.id)}&kind=cloned&variant=desktop`,
      });
    }
  }
  return map;
}

/** Canonical archive keys that should appear for a Clone/Swipe step type. */
export function archiveKeysForStepType(stepType: string, extraKnown: string[] = []): string[] {
  const t = normalizeArchiveType(stepType, extraKnown);
  if (t === 'altro') return [t];
  if (/^upsell(_\d+)?$/.test(t) || t === 'upsell_1') {
    return ['upsell_1', 'upsell_2', 'upsell_3', t].filter((v, i, a) => a.indexOf(v) === i);
  }
  if (/^downsell(_\d+)?$/.test(t) || t === 'downsell_1') {
    return ['downsell_1', 'downsell_2', 'downsell_3', t].filter((v, i, a) => a.indexOf(v) === i);
  }
  return [t];
}

type LibraryTemplate = {
  id: string;
  name: string;
  sourceUrl?: string;
  pageType?: string;
  previewImage?: string;
};

/** Fold swipe_templates (Template library) into the By Type archive map. */
export function mergeLibraryTemplatesByType(
  map: Record<string, ArchiveTemplatePage[]>,
  templates: LibraryTemplate[],
  knownCustomTypes: string[] = [],
): Record<string, ArchiveTemplatePage[]> {
  const out: Record<string, ArchiveTemplatePage[]> = { ...map };
  for (const t of templates || []) {
    const type = normalizeArchiveType(t.pageType, knownCustomTypes);
    const url = t.sourceUrl || '';
    if (!url) continue;
    const list = out[type] ? [...out[type]] : [];
    if (list.some((p) => p.url_to_swipe === url)) continue;
    list.push({
      funnel_name: 'Templates',
      funnel_id: t.id,
      name: t.name,
      url_to_swipe: url,
      prompt: '',
      page_type: type,
      screenshotUrl: t.previewImage || null,
      htmlUrl: null,
    });
    out[type] = list;
  }
  return out;
}

/** Templates from Template → By Type plus the library catalog, for one step type. */
export function listTemplatesForStepType(
  stepType: string,
  archivedFunnels: ArchivedFunnel[],
  templates: LibraryTemplate[],
  knownCustomTypes: string[] = [],
): ArchiveTemplatePage[] {
  const map = mergeLibraryTemplatesByType(
    listArchivePagesByType(archivedFunnels || [], knownCustomTypes),
    templates,
    knownCustomTypes,
  );
  const keys = archiveKeysForStepType(stepType, knownCustomTypes);
  const out: ArchiveTemplatePage[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    for (const p of map[k] || []) {
      const dedupe = `${p.url_to_swipe}::${p.name}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(p);
    }
  }
  return out;
}

/** Stable <option> value: library UUID as-is, archive pages prefixed. */
export function pickerValueForTemplate(p: ArchiveTemplatePage): string {
  if (p.funnel_name === 'Templates') return p.funnel_id;
  return `arc:${p.funnel_id}::${encodeURIComponent(p.url_to_swipe || p.name)}`;
}
