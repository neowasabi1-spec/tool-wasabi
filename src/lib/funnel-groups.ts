import type { FunnelCrawlStepRow } from '@/types/database';

export type FunnelGroup = {
  key: string;
  funnelName: string;
  funnelNameDb: string;
  funnelTag: string | null;
  entryUrl: string;
  steps: FunnelCrawlStepRow[];
  createdAt: string;
};

const FUNNEL_KEY_SEP = '\u001e';

export function groupStepsByFunnel(steps: FunnelCrawlStepRow[]): FunnelGroup[] {
  const map = new Map<string, FunnelCrawlStepRow[]>();
  const createdAtMap = new Map<string, string>();
  for (const step of steps) {
    const key = `${step.entry_url}${FUNNEL_KEY_SEP}${step.funnel_name}`;
    if (!map.has(key)) {
      map.set(key, []);
      createdAtMap.set(key, step.created_at);
    }
    map.get(key)!.push(step);
  }
  const groups: FunnelGroup[] = [];
  map.forEach((stepList, key) => {
    const idx = key.indexOf(FUNNEL_KEY_SEP);
    const entryUrl = idx >= 0 ? key.slice(0, idx) : key;
    const first = stepList[0];
    const funnelNameDb = first?.funnel_name ?? (idx >= 0 ? key.slice(idx + 1) : '');
    const funnelTag = first?.funnel_tag ?? null;
    const sorted = [...stepList].sort((a, b) => a.step_index - b.step_index);
    groups.push({
      key,
      funnelName: funnelNameDb || 'Unnamed',
      funnelNameDb,
      funnelTag,
      entryUrl,
      steps: sorted,
      createdAt: createdAtMap.get(key) || '',
    });
  });
  groups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return groups;
}
