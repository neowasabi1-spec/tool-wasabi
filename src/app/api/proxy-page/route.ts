import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

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

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 });
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 502 });
    }

    const rawHtml = await res.text();
    const html = absolutizeUrls(rawHtml, url);

    return NextResponse.json({ html, url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Fetch failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
