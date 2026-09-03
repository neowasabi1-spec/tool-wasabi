import { fetchHtmlFromStorage } from '@/lib/funnel-html-storage';

export type ChimeraSwipePageStatus = {
  id: string;
  swipeStatus: string;
  swipeResult: string;
};

export async function startChimeraRestyle(opts: {
  pageIds: string[];
  projectId: string;
  imageMode?: 'internal' | 'affiliate';
  skipTexts?: boolean;
}): Promise<{ ok: boolean; error?: string; photo?: boolean }> {
  const res = await fetch('/api/chimera/swipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageIds: opts.pageIds,
      projectId: opts.projectId,
      imageMode: opts.imageMode || 'internal',
      skipTexts: opts.skipTexts === true,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; photo?: boolean };
  if (!res.ok || data.error) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, photo: data.photo };
}

export async function pollChimeraRestyle(opts: {
  pageIds: string[];
  onProgress?: (page: ChimeraSwipePageStatus) => void;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ChimeraSwipePageStatus[]> {
  const timeoutMs = opts.timeoutMs ?? 60 * 60_000;
  const intervalMs = opts.intervalMs ?? 4000;
  const t0 = Date.now();
  let lastById = new Map<string, string>();
  let startedAt = 0;

  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const qs = opts.pageIds.map(encodeURIComponent).join(',');
    const res = await fetch(`/api/chimera/swipe?ids=${qs}`, { cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as {
      pages?: ChimeraSwipePageStatus[];
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `Poll HTTP ${res.status}`);
    const pages = data.pages || [];
    for (const p of pages) {
      const key = `${p.swipeStatus}|${p.swipeResult}`;
      if (lastById.get(p.id) !== key) {
        lastById.set(p.id, key);
        opts.onProgress?.(p);
      }
      if (!startedAt && /texts rewritten|palette|photo|gif|video|visual world|Clone\/Swipe/i.test(p.swipeResult || '')) {
        startedAt = Date.now();
      }
    }
    const done = pages.length > 0 && pages.every((p) => p.swipeStatus === 'completed' || p.swipeStatus === 'failed');
    if (done) return pages;
    if (Date.now() - t0 > 10 * 60_000 && !startedAt) {
      throw new Error('Restyle worker did not start. Wait for deploy, then swipe again.');
    }
  }
  throw new Error('Restyle timed out (60 min). Check Clone/Swipe status and retry.');
}

export async function loadSwipedHtml(pageId: string): Promise<string> {
  const bust = `v=${Date.now()}`;
  const base = `/api/funnel-html?pageId=${encodeURIComponent(pageId)}`;
  return (
    (await fetchHtmlFromStorage(`${base}&kind=swiped&variant=desktop&${bust}`))
    || (await fetchHtmlFromStorage(`${base}&kind=cloned&variant=desktop&${bust}`))
    || ''
  );
}

export async function runChimeraInternalSwipe(opts: {
  pageIds: string[];
  projectId: string;
  skipTexts?: boolean;
  onProgress?: (page: ChimeraSwipePageStatus) => void;
}): Promise<{ ok: boolean; htmlUrl?: string; summary?: string; error?: string; pages?: ChimeraSwipePageStatus[] }> {
  const started = await startChimeraRestyle({
    pageIds: opts.pageIds,
    projectId: opts.projectId,
    imageMode: 'internal',
    skipTexts: opts.skipTexts === true,
  });
  if (!started.ok) return { ok: false, error: started.error };

  try {
    const pages = await pollChimeraRestyle({
      pageIds: opts.pageIds,
      onProgress: opts.onProgress,
    });
    const failed = pages.find((p) => p.swipeStatus === 'failed');
    const htmlUrl = opts.pageIds.length === 1
      ? `/api/funnel-html?pageId=${encodeURIComponent(opts.pageIds[0])}&kind=swiped&variant=desktop&v=${Date.now()}`
      : '';
    if (failed) return { ok: false, error: failed.swipeResult || 'Restyle failed', pages, htmlUrl };
    const summary = pages.map((p) => p.swipeResult).filter(Boolean).join(' · ')
      || 'Internal restyle completed';
    return { ok: true, htmlUrl, summary, pages };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
