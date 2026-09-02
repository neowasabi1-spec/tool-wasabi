/**
 * Where an archived_funnels row belongs, and how to treat duplicate steps.
 *
 *   project_id set  → Competitor Library only (never Templates)
 *   section=funnel or 2+ steps → Templates → Funnel
 *   1 step, not a walk-sibling → Templates → Pages
 */

export function canonPageUrl(raw: string): string {
  const u = String(raw || '').trim();
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [
      'fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
      'c1', 'c2', 'c3', 'aff_id', 'affiliate_id', 'transaction_id', 'clickid',
    ]) {
      x.searchParams.delete(k);
    }
    const path = x.pathname.replace(/\/+$/, '') || '/';
    const q = x.searchParams.toString();
    return `${x.protocol}//${x.host.toLowerCase()}${path.toLowerCase()}${q ? `?${q}` : ''}`;
  } catch {
    return u.toLowerCase().replace(/\/+$/, '');
  }
}

export function stepSourceUrl(s: {
  url_to_swipe?: unknown;
  cloned_data?: { source_url?: unknown } | null;
}): string {
  return String(s?.url_to_swipe || s?.cloned_data?.source_url || '');
}

export function dedupeStepsByUrl<T extends Record<string, unknown>>(steps: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of steps) {
    const k = canonPageUrl(stepSourceUrl(s as { url_to_swipe?: unknown; cloned_data?: { source_url?: unknown } }));
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(s);
  }
  return out;
}

export function archiveStepCount(f: { steps?: unknown; total_steps?: number | null }): number {
  const n = Array.isArray(f.steps) ? f.steps.length : 0;
  return Math.max(n, f.total_steps || 0);
}

export const WALK_STEP_RE = /^(.*\S)\s+—\s+Step\s+(\d+)$/i;

export type WalkMergeable = {
  id: string;
  name: string;
  steps?: unknown;
  total_steps?: number | null;
  created_at: string;
  isShared?: boolean;
  section?: string | null;
};

/** Fold "<domain> — Step N" single-step rows into one funnel, like Templates. */
export function mergeWalkFunnels<T extends WalkMergeable>(
  rows: T[],
): Array<T & { __merged?: boolean; __memberIds?: string[] }> {
  const groups = new Map<string, T[]>();
  const passthrough: Array<T & { __merged?: boolean; __memberIds?: string[] }> = [];
  for (const f of rows) {
    const m = f.name.match(WALK_STEP_RE);
    const steps = Array.isArray(f.steps) ? f.steps : [];
    if (m && steps.length <= 1 && !f.isShared) {
      const key = m[1].trim();
      const arr = groups.get(key) || [];
      arr.push(f);
      groups.set(key, arr);
    } else {
      passthrough.push(f);
    }
  }
  const stepNumOf = (name: string) => {
    const mm = name.match(/Step\s+(\d+)/i);
    return mm ? parseInt(mm[1], 10) : 0;
  };
  const merged: Array<T & { __merged?: boolean; __memberIds?: string[] }> = [];
  groups.forEach((groupRows, domain) => {
    if (groupRows.length <= 1) {
      passthrough.push(groupRows[0]);
      return;
    }
    const sorted = [...groupRows].sort((a, b) => stepNumOf(a.name) - stepNumOf(b.name));
    const mergedSteps = dedupeStepsByUrl(
      sorted.map((r) => {
        const s = ((Array.isArray(r.steps) ? r.steps : [])[0] || {}) as Record<string, unknown>;
        return { ...s };
      }),
    ).map((s, i) => ({ ...s, step_index: i + 1, name: s.name || `Step ${i + 1}` }));
    const latest = sorted.reduce(
      (acc, r) => (new Date(r.created_at) > new Date(acc.created_at) ? r : acc),
      sorted[0],
    );
    merged.push({
      ...latest,
      name: domain,
      total_steps: mergedSteps.length,
      steps: mergedSteps,
      __merged: true,
      __memberIds: sorted.map((r) => r.id),
    });
  });
  return [...passthrough, ...merged];
}

/** True when this row is a loose page that belongs ONLY in Templates → Pages. */
export function isStandaloneTemplatePage(
  f: { name: string; steps?: unknown; total_steps?: number | null; section?: string | null; isShared?: boolean },
  all: Array<{ name: string; steps?: unknown; isShared?: boolean }>,
): boolean {
  // DB default for `section` is 'funnel' on every historical row — do not
  // treat that as "this is a funnel". Only multi-step / walk folders leave Pages.
  if (archiveStepCount(f) > 1) return false;
  const m = f.name.match(WALK_STEP_RE);
  if (m && !f.isShared) {
    const key = m[1].trim();
    const sibs = all.filter((x) => {
      const mm = x.name.match(WALK_STEP_RE);
      const xs = Array.isArray(x.steps) ? x.steps.length : 0;
      return !!(mm && mm[1].trim() === key && xs <= 1 && !x.isShared);
    });
    if (sibs.length > 1) return false;
  }
  return true;
}

export const UPSELL_RE = /upsell|downsell|\boto\b|bump/i;

export function isUpsellPageType(pageType: string): boolean {
  return UPSELL_RE.test(pageType || '');
}

/** 1 main (if any non-upsell step) + one product per selected upsell/OTO. */
export function countProductsFromSteps(
  steps: Array<{ pageType?: string; page_type?: string; isUpsell?: boolean }>,
): { products: number; upsells: number; hasMain: boolean } {
  if (!steps.length) return { products: 0, upsells: 0, hasMain: false };
  const upsells = steps.filter((s) =>
    s.isUpsell ?? isUpsellPageType(String(s.pageType || s.page_type || '')),
  ).length;
  const hasMain = steps.some(
    (s) => !(s.isUpsell ?? isUpsellPageType(String(s.pageType || s.page_type || ''))),
  );
  return { products: (hasMain ? 1 : 0) + upsells || 1, upsells, hasMain };
}

export type PickerStep = {
  index: number;
  name: string;
  pageType: string;
  isUpsell: boolean;
  url?: string;
  pageId?: string;
  htmlUrl?: string;
};

export type PickerFunnel = {
  id: string;
  name: string;
  totalSteps: number;
  upsells: number;
  products: number;
  isProject: boolean;
  created_at: string;
  steps: PickerStep[];
};

function slimPickerStep(s: Record<string, unknown>, i: number): PickerStep {
  const pageType = String(s.page_type || s.step_type || '');
  const cloned =
    s.cloned_data && typeof s.cloned_data === 'object' && !Array.isArray(s.cloned_data)
      ? (s.cloned_data as Record<string, unknown>)
      : {};
  const url = String(s.url_to_swipe || cloned.source_url || '').trim();
  const htmlUrl = typeof cloned.htmlUrl === 'string' ? cloned.htmlUrl : '';
  const pageId = typeof s.page_id === 'string' ? s.page_id : '';
  return {
    index: i,
    name: String(s.name || `Step ${i + 1}`),
    pageType,
    isUpsell: isUpsellPageType(pageType),
    url: url || undefined,
    pageId: pageId || undefined,
    htmlUrl: htmlUrl || undefined,
  };
}

/** Same multi-step / merged-walk list as Templates → Funnel, shaped for pickers. */
export function pickerFunnelsFromArchive(
  rows: Array<WalkMergeable & { project_id?: string | null }>,
  projectId?: string,
): PickerFunnel[] {
  return mergeWalkFunnels(rows)
    .filter((row) => row.section !== 'page')
    .map((row) => {
      const raw = Array.isArray(row.steps) ? (row.steps as Record<string, unknown>[]) : [];
      const unique = dedupeStepsByUrl(raw);
      const steps = unique.map((s, i) => slimPickerStep(s, i));
      const counts = countProductsFromSteps(steps);
      const totalSteps = Math.max(steps.length, archiveStepCount({ ...row, steps: unique }));
      return {
        id: row.id,
        name: row.name || 'Funnel',
        totalSteps,
        upsells: counts.upsells,
        products: counts.products,
        isProject: !!(projectId && row.project_id === projectId),
        created_at: row.created_at,
        steps,
      };
    })
    .filter((f) => f.totalSteps >= 2)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}
