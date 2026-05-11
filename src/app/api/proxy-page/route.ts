import { NextRequest, NextResponse } from 'next/server';
import { fetchHtmlSmart } from '@/lib/fetch-html-smart';

export const maxDuration = 60;

function absolutizeUrls(html: string, sourceUrl: string): string {
  try {
    const urlObj = new URL(sourceUrl);
    const origin = urlObj.origin;
    const basePath = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);

    let fixed = html;

    if (!fixed.includes('<base ')) {
      const baseTag = `<base href="${basePath}" target="_blank" />`;
      if (fixed.includes('<head>')) {
        fixed = fixed.replace('<head>', `<head>${baseTag}`);
      } else if (/<head\s/.test(fixed)) {
        fixed = fixed.replace(/<head(\s)/, `<head><base href="${basePath}" target="_blank" /><head$1`);
      } else {
        fixed = `<head><base href="${basePath}" target="_blank" /></head>` + fixed;
      }
    }

    fixed = fixed.replace(
      /(src|href|poster|data-src|data-lazy-src|srcset)=(["'])((?!https?:\/\/|data:|blob:|#|mailto:|javascript:|\/\/).*?)\2/gi,
      (_m: string, attr: string, quote: string, path: string) => {
        const trimmed = path.trim();
        if (!trimmed) return `${attr}=${quote}${path}${quote}`;
        if (attr.toLowerCase() === 'srcset') {
          const parts = trimmed.split(',').map(p => {
            const [url, ...rest] = p.trim().split(/\s+/);
            const absUrl = url.startsWith('//') ? urlObj.protocol + url
              : url.startsWith('/') ? origin + url
              : basePath + url;
            return [absUrl, ...rest].join(' ');
          });
          return `${attr}=${quote}${parts.join(', ')}${quote}`;
        }
        const abs = trimmed.startsWith('//')
          ? urlObj.protocol + trimmed
          : trimmed.startsWith('/')
          ? origin + trimmed
          : basePath + trimmed;
        return `${attr}=${quote}${abs}${quote}`;
      }
    );

    fixed = fixed.replace(/loading=["']lazy["']/gi, 'loading="eager"');

    if (fixed.includes('<head>')) {
      fixed = fixed.replace('<head>', '<head><meta name="referrer" content="no-referrer">');
    }

    return fixed;
  } catch {
    return html;
  }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return new NextResponse('<html><body>Missing url</body></html>', { status: 400, headers: { 'Content-Type': 'text/html' } });
  }
  try {
    const fetched = await fetchHtmlSmart(url, {
      mode: 'full',
      fetchTimeoutMs: 15000,
      playwrightTimeoutMs: 25000,
    });
    if (!fetched.ok || !fetched.html) {
      return new NextResponse(
        `<html><body>Could not load page: ${fetched.error ?? 'unknown error'}</body></html>`,
        { status: 502, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const html = absolutizeUrls(fetched.html, url);
    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Wasabi-Source': fetched.source ?? 'unknown',
        'X-Wasabi-Was-Spa': String(fetched.wasSpa),
      },
    });
  } catch {
    return new NextResponse('<html><body>Could not load page</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 });
    }

    const fetched = await fetchHtmlSmart(url, {
      mode: 'full',
      fetchTimeoutMs: 15000,
      playwrightTimeoutMs: 25000,
    });
    if (!fetched.ok || !fetched.html) {
      return NextResponse.json(
        { error: fetched.error ?? 'Fetch failed', attempts: fetched.attempts },
        { status: 502 },
      );
    }
    const html = absolutizeUrls(fetched.html, url);

    return NextResponse.json({
      html,
      url,
      method_used: fetched.source,
      was_spa: fetched.wasSpa,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Fetch failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
