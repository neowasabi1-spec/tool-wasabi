import { NextRequest, NextResponse } from 'next/server';

const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v1';

export async function POST(request: NextRequest) {
  try {
    const { url, action, apiKey, options } = await request.json();

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'Firecrawl API Key is required' },
        { status: 400 }
      );
    }

    const startTime = Date.now();
    let endpoint = '';
    let body: Record<string, unknown> = { url };

    switch (action) {
      case 'scrape':
        endpoint = '/scrape';
        body = {
          url,
          formats: options?.formats || ['markdown', 'html'],
          onlyMainContent: options?.onlyMainContent ?? true,
          includeTags: options?.includeTags || [],
          excludeTags: options?.excludeTags || [],
          waitFor: options?.waitFor || 0,
        };
        break;
      case 'crawl':
        endpoint = '/crawl';
        body = {
          url,
          limit: options?.limit || 10,
          scrapeOptions: {
            formats: options?.formats || ['markdown'],
            onlyMainContent: options?.onlyMainContent ?? true,
          },
          maxDepth: options?.maxDepth || 2,
          allowBackwardLinks: options?.allowBackwardLinks ?? false,
          allowExternalLinks: options?.allowExternalLinks ?? false,
        };
        break;
      case 'map':
        endpoint = '/map';
        body = {
          url,
          search: options?.search || '',
          ignoreSitemap: options?.ignoreSitemap ?? false,
          includeSubdomains: options?.includeSubdomains ?? false,
          limit: options?.limit || 100,
        };
        break;
      default:
        endpoint = '/scrape';
        body = {
          url,
          formats: ['markdown', 'html'],
          onlyMainContent: true,
        };
    }

    const response = await fetch(`${FIRECRAWL_API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const duration = (Date.now() - startTime) / 1000;

    if (!response.ok) {
      return NextResponse.json(
        { 
          success: false, 
          error: data.error || `Firecrawl error: ${response.status}`,
          statusCode: response.status,
          duration,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      success: true,
      action,
      url,
      duration,
      data,
    });
  } catch (error) {
    console.error('Firecrawl call error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Error during Firecrawl call' 
      },
      { status: 500 }
    );
  }
}
