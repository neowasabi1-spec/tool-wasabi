import { NextRequest, NextResponse } from 'next/server';

const CACHE = new Map<string, { data: ArrayBuffer; contentType: string; ts: number }>();
const TTL = 1000 * 60 * 60 * 4; // 4 hours

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.ts < TTL) {
    return new Response(cached.data, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'public, max-age=14400',
      },
    });
  }

  const encodedUrl = encodeURIComponent(url);

  // Multiple services — ordered by reliability (mshots last as it returns WP logo placeholders)
  const services = [
    // thum.io — very reliable for most pages
    `https://image.thum.io/get/width/600/crop/900/${url}`,
    // Google PageSpeed screenshot
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodedUrl}&category=PERFORMANCE&strategy=DESKTOP`,
    // microlink
    `https://api.microlink.io/?url=${encodedUrl}&screenshot=true&meta=false&embed=screenshot.url`,
    // WordPress mshots — last resort (often returns WP logo placeholder for quiz/dynamic pages)
    `https://s0.wp.com/mshots/v1/${encodedUrl}?w=600&h=450`,
  ];

  for (let i = 0; i < services.length; i++) {
    const serviceUrl = services[i];
    try {
      // Google PageSpeed returns JSON with embedded screenshot
      if (serviceUrl.includes('googleapis.com/pagespeedonline')) {
        const res = await fetch(serviceUrl, {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!res.ok) continue;
        const json = await res.json();
        const screenshotData = json?.lighthouseResult?.audits?.['final-screenshot']?.details?.data;
        if (!screenshotData || typeof screenshotData !== 'string') continue;

        // It's a data:image/jpeg;base64,... string
        const base64 = screenshotData.split(',')[1];
        if (!base64 || base64.length < 100) continue;

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
        const arrayBuf = bytes.buffer as ArrayBuffer;

        CACHE.set(url, { data: arrayBuf, contentType: 'image/jpeg', ts: Date.now() });
        return new Response(arrayBuf, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=14400',
          },
        });
      }

      const res = await fetch(serviceUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';

      // wp.com/mshots returns a WP logo placeholder (10-30KB) when it can't render a page.
      // Real screenshots at 600x450 are typically 40KB+.
      if (serviceUrl.includes('wp.com/mshots')) {
        const arrayBuf = await res.arrayBuffer();
        if (arrayBuf.byteLength < 40000) continue;

        CACHE.set(url, { data: arrayBuf, contentType: contentType || 'image/jpeg', ts: Date.now() });
        return new Response(arrayBuf, {
          headers: {
            'Content-Type': contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=14400',
          },
        });
      }

      if (!contentType.startsWith('image/')) continue;

      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength < 1000) continue;

      CACHE.set(url, { data: arrayBuf, contentType, ts: Date.now() });
      return new Response(arrayBuf, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=14400',
        },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: 'Could not generate thumbnail' }, { status: 502 });
}
