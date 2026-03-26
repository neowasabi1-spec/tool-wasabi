import { NextRequest, NextResponse } from 'next/server';

const CLONER_API_URL = process.env.CLONER_API_URL || 'http://localhost:8080';

function fixClonedHtml(html: string, sourceUrl: string): string {
  let fixed = html;
  fixed = fixed.replace(
    /(src|srcset|poster|data-src|data-lazy-src)=(["'])(.*?)\2/gi,
    (_m, attr, quote, value) => {
      if (attr.toLowerCase() === 'srcset') {
        const unwrapped = value.replace(
          /https?:\/\/[^/]+\/cdn-cgi\/image\/[^/]*\/(https?:\/\/[^\s,]+)/gi, '$1'
        );
        return `${attr}=${quote}${unwrapped}${quote}`;
      }
      const match = value.match(/\/cdn-cgi\/image\/[^/]*\/(https?:\/\/.+)/i);
      return match
        ? `${attr}=${quote}${match[1]}${quote}`
        : `${attr}=${quote}${value}${quote}`;
    }
  );
  fixed = fixed.replace(/loading=["']lazy["']/gi, 'loading="eager"');

  try {
    const urlObj = new URL(sourceUrl);
    const origin = urlObj.origin;
    const basePath = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);
    fixed = fixed.replace(
      /(src|href|poster|data-src|data-lazy-src)=(["'])((?!https?:\/\/|data:|#|mailto:|javascript:|\/\/).*?)\2/gi,
      (_m, attr, quote, path) => {
        const trimmed = path.trim();
        if (!trimmed) return `${attr}=${quote}${path}${quote}`;
        const abs = trimmed.startsWith('//') ? urlObj.protocol + trimmed
          : trimmed.startsWith('/') ? origin + trimmed
          : basePath + trimmed;
        return `${attr}=${quote}${abs}${quote}`;
      }
    );
  } catch { /* sourceUrl parse failed, skip absolutize */ }
  return fixed;
}

export interface CloneRequest {
  url: string;
  wait_for_js?: boolean;
  remove_scripts?: boolean;
}

export interface CloneResponse {
  url: string;
  method_used: string;
  content_length: number;
  title: string;
  duration_seconds: number;
  html: string;
  success: boolean;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: CloneRequest = await request.json();

    if (!body.url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    // Validazione URL
    try {
      new URL(body.url);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    // Chiamata al servizio di clonazione
    const cloneResponse = await fetch(`${CLONER_API_URL}/api/landing/clone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: body.url,
        wait_for_js: body.wait_for_js ?? false,
        remove_scripts: body.remove_scripts ?? true,
      }),
    });

    if (!cloneResponse.ok) {
      const errorText = await cloneResponse.text();
      return NextResponse.json(
        { 
          success: false, 
          error: `Cloner service error: ${cloneResponse.status} - ${errorText}` 
        },
        { status: cloneResponse.status }
      );
    }

    const data: CloneResponse = await cloneResponse.json();

    const cleanHtml = data.html ? fixClonedHtml(data.html, body.url) : data.html;

    return NextResponse.json({
      success: true,
      url: data.url,
      method_used: data.method_used,
      content_length: cleanHtml?.length || data.content_length,
      title: data.title,
      duration_seconds: data.duration_seconds,
      html: cleanHtml,
      html_preview: cleanHtml?.substring(0, 500) + '...',
    });

  } catch (error) {
    console.error('Clone API error:', error);
    
    // Handle service connection error
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Impossibile connettersi al servizio di clonazione. Assicurati che sia in esecuzione su localhost:8080' 
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
