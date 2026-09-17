import { isStandaloneTemplatePage } from '@/lib/archive-placement';
import { humanizePageTypeSlug, normalizeArchiveType } from '@/types';
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

export type ArchiveTemplateGroup = {
  type: string;
  label: string;
  pages: ArchiveTemplatePage[];
};

function cardShotUrl(cd?: ClonedShots | null): string | null {
  return cd?.screenshotMobileUrl || cd?.screenshotDesktopUrl || null;
}

/** Pages from Template section folders, grouped by canonical page_type.
 *  By default only By Type (standalone) pages. Pass includeFunnels to also
 *  pull matching steps out of Funnel folders. Never includes swipe_templates. */
export function listArchivePagesByType(
  archivedFunnels: ArchivedFunnel[],
  knownCustomTypes: string[] = [],
  opts?: { includeFunnels?: boolean },
): Record<string, ArchiveTemplatePage[]> {
  const map: Record<string, ArchiveTemplatePage[]> = {};
  const all = archivedFunnels || [];
  for (const f of all) {
    // Competitor Library rows never belong in Templates / Clone-Swipe.
    if ((f as { project_id?: string | null }).project_id) continue;
    if (!opts?.includeFunnels && !isStandaloneTemplatePage(f, all)) continue;
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

/** Canonical archive keys that should appear first for a Clone/Swipe step type. */
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

/** Only the Template → By Type folder(s) that match this Clone/Swipe Type. */
export function listTemplateSectionGroups(
  stepType: string,
  archivedFunnels: ArchivedFunnel[],
  knownCustomTypes: string[] = [],
): ArchiveTemplateGroup[] {
  const map = listArchivePagesByType(archivedFunnels || [], knownCustomTypes, {
    includeFunnels: false,
  });
  const preferred = archiveKeysForStepType(stepType, knownCustomTypes);
  const groups: ArchiveTemplateGroup[] = [];
  const seenType = new Set<string>();
  for (const type of preferred) {
    if (seenType.has(type)) continue;
    const pages = map[type] || [];
    if (!pages.length) continue;
    seenType.add(type);
    groups.push({
      type,
      label: type === 'altro' ? 'Altro' : humanizePageTypeSlug(type) || type,
      pages,
    });
  }
  return groups;
}

/** Pages from the matching Template → By Type folder only. */
export function listTemplatesForStepType(
  stepType: string,
  archivedFunnels: ArchivedFunnel[],
  _unusedLibrary?: unknown,
  knownCustomTypes: string[] = [],
): ArchiveTemplatePage[] {
  return listTemplateSectionGroups(stepType, archivedFunnels || [], knownCustomTypes)
    .flatMap((g) => g.pages);
}

/** Stable <option> value for an archive page from Template section. */
export function pickerValueForTemplate(p: ArchiveTemplatePage): string {
  return `arc:${p.funnel_id}::${encodeURIComponent(p.url_to_swipe || p.name)}`;
}
