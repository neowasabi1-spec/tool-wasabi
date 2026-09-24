import { buildSwipeAssetMap, type SwipeAssetMap } from './swipe-asset-map';
import { readHealStamp } from './lander-heal';
import { pageNeedsJsRender } from './spa-rescue';

export async function understandClonedLander(
  html: string,
  url: string,
): Promise<{ html: string; map: SwipeAssetMap }> {
  const local = buildSwipeAssetMap(html);
  if (!html || html.length < 80) return { html, map: local };
  // JS shells need a browser freeze in clone-funnel, not a screenshot
  // of an empty page. Static HTML already maps without an LLM.
  if (pageNeedsJsRender(html)) return { html, map: local };
  const remaining = readHealStamp(html).remaining;
  const known =
    local.understood &&
    local.family !== 'unknown' &&
    local.texts.length >= 3 &&
    remaining.length === 0;
  if (known) return { html, map: local };
  try {
    const tooBig = html.length > 1_200_000;
    const res = await fetch('/api/lander-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tooBig ? { url, map: local } : { html, url, map: local }),
    });
    if (!res.ok) return { html, map: local };
    const data = (await res.json()) as { html?: string; map?: SwipeAssetMap };
    return {
      html: typeof data.html === 'string' && data.html.length > 80 ? data.html : html,
      map: data.map?.texts ? data.map : local,
    };
  } catch {
    return { html, map: local };
  }
}
