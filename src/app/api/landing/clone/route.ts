import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

function makeAbsolute(path: string, origin: string, basePath: string, protocol: string): string {
  const trimmed = path.trim();
  if (!trimmed || /^(https?:\/\/|data:|#|mailto:|javascript:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return protocol + trimmed;
  if (trimmed.startsWith('/')) return origin + trimmed;
  return basePath + trimmed;
}

function fixClonedHtml(html: string, sourceUrl: string): string {
  let fixed = html;
  fixed = fixed.replace(/loading=["']lazy["']/gi, 'loading="eager"');
  fixed = fixed.replace(/<img\b/gi, '<img referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<video\b/gi, '<video referrerpolicy="no-referrer" ');
  fixed = fixed.replace(/<source\b/gi, '<source referrerpolicy="no-referrer" ');
  if (fixed.includes('<head>')) {
    fixed = fixed.replace('<head>', '<head><meta name="referrer" content="no-referrer">');
  } else {
    fixed = '<meta name="referrer" content="no-referrer">' + fixed;
  }

  try {
    const urlObj = new URL(sourceUrl);
    const origin = urlObj.origin;
    const basePath = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
    const protocol = urlObj.protocol;

    fixed = fixed
      .replace(/(srcset)=(["'])(.*?)\2/gi, (_match, attr, quote, value) => {
        if (/^\s*(https?:\/\/|\/\/)/i.test(value)) return `${attr}=${quote}${value}${quote}`;
        const parts = value.split(/,(?=\s)/).map((entry: string) => {
          const segs = entry.trim().split(/\s+/);
          if (segs.length === 0) return entry;
          segs[0] = makeAbsolute(segs[0], origin, basePath, protocol);
          return segs.join(' ');
        });
        return `${attr}=${quote}${parts.join(', ')}${quote}`;
      })
      .replace(
        /(src|href|poster|data-src|data-lazy-src)=(["'])((?!https?:\/\/|data:|#|mailto:|javascript:|\/\/).*?)\2/gi,
        (_m, attr, quote, path) => `${attr}=${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote}`
      )
      .replace(
        /url\((['"]?)((?!https?:\/\/|data:|#)(?:\/[^)'"]+|[^)'"\s]+))\1\)/gi,
        (_m, quote, path) => `url(${quote}${makeAbsolute(path, origin, basePath, protocol)}${quote})`
      );
  } catch { /* sourceUrl parse failed */ }
  return fixed;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, remove_scripts } = body as { url?: string; remove_scripts?: boolean };

    if (!url) {
      return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
    }

    try { new URL(url); } catch {
      return NextResponse.json({ success: false, error: 'Invalid URL format' }, { status: 400 });
    }

    const start = Date.now();

    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    if (!pageRes.ok) {
      return NextResponse.json(
        { success: false, error: `Unable to clone the page: HTTP ${pageRes.status} ${pageRes.statusText}` },
        { status: 400 },
      );
    }

    let html = await pageRes.text();
    const duration = (Date.now() - start) / 1000;

    if (remove_scripts !== false) {
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

    const cleanHtml = fixClonedHtml(html, url);

    return NextResponse.json({
      success: true,
      url,
      method_used: 'direct-fetch',
      content_length: cleanHtml.length,
      title,
      duration_seconds: duration,
      html: cleanHtml,
      html_preview: cleanHtml.substring(0, 500) + '...',
    });
  } catch (error) {
    console.error('Clone API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
