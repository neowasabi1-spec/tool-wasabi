import { NextRequest, NextResponse } from 'next/server';

const CACHE = new Map<string, { data: Buffer; ts: number }>();
const TTL = 1000 * 60 * 60; // 1 hour

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.ts < TTL) {
    return new NextResponse(cached.data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const services = [
    `https://image.thum.io/get/width/600/crop/900/${url}`,
    `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`,
  ];

  for (const serviceUrl of services) {
    try {
      const res = await fetch(serviceUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) continue;

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      if (buf.length < 1000) continue;

      CACHE.set(url, { data: buf, ts: Date.now() });

      return new NextResponse(buf, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: 'Could not generate thumbnail' }, { status: 502 });
}
