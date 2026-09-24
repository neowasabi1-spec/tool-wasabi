import { NextRequest, NextResponse } from 'next/server';
import { understandLander } from '@/lib/lander-agent';
import { buildSwipeAssetMap, compactSwipeMap, type SwipeAssetMap } from '@/lib/swipe-asset-map';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    html?: string;
    url?: string;
    map?: SwipeAssetMap;
  };
  const html = typeof body.html === 'string' ? body.html : '';
  const url = typeof body.url === 'string' ? body.url : '';

  if (html.length >= 80) {
    try {
      const result = await understandLander(html, url);
      return NextResponse.json({
        ok: true,
        html: result.html,
        map: result.map,
        visioned: result.visioned,
      });
    } catch (err) {
      const fallback = compactSwipeMap(body.map || buildSwipeAssetMap(html));
      return NextResponse.json({
        ok: false,
        html,
        map: fallback,
        visioned: false,
        error: err instanceof Error ? err.message : 'lander-agent failed',
      });
    }
  }

  if (body.map?.texts) {
    return NextResponse.json({
      ok: true,
      html: '',
      map: compactSwipeMap(body.map),
      visioned: false,
    });
  }

  return NextResponse.json({ error: 'html required' }, { status: 400 });
}
