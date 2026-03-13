import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { url, pageType, template } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    // Fetch the page to extract content
    const pageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FunnelAnalyzer/1.0)',
      },
    });

    if (!pageResponse.ok) {
      return NextResponse.json(
        { error: `Unable to load the page: ${pageResponse.status}` },
        { status: 400 }
      );
    }

    const html = await pageResponse.text();

    // Extract key elements from the page
    const extractedData: {
      headline: string;
      subheadline: string;
      cta: string[];
      price: string | null;
      benefits: string[];
    } = {
      headline: '',
      subheadline: '',
      cta: [],
      price: null,
      benefits: [],
    };

    // Extract headline (h1)
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi);
    if (h1Match && h1Match.length > 0) {
      extractedData.headline = h1Match[0].replace(/<[^>]*>/g, '').trim();
    }

    // Extract subheadline (first h2 or first p after h1)
    const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      extractedData.subheadline = h2Match[1].replace(/<[^>]*>/g, '').trim();
    }

    // Extract CTA (buttons)
    const buttonMatches = html.match(/<button[^>]*>([\s\S]*?)<\/button>/gi) || [];
    const linkButtonMatches = html.match(/<a[^>]*class="[^"]*btn[^"]*"[^>]*>([\s\S]*?)<\/a>/gi) || [];
    
    [...buttonMatches, ...linkButtonMatches].forEach((btn) => {
      const text = btn.replace(/<[^>]*>/g, '').trim();
      if (text && text.length < 50 && !extractedData.cta.includes(text)) {
        extractedData.cta.push(text);
      }
    });

    // Extract prices
    const priceMatch = html.match(/[€$£]\s*\d+[.,]?\d*/);
    if (priceMatch) {
      extractedData.price = priceMatch[0];
    }

    // Extract benefits (li inside ul)
    const liMatches = html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    liMatches.slice(0, 10).forEach((li) => {
      const text = li.replace(/<[^>]*>/g, '').trim();
      if (text && text.length > 10 && text.length < 200) {
        extractedData.benefits.push(text);
      }
    });

    // Build the prompt for analysis
    const prompt = `Analyze this funnel step (${pageType || 'landing page'}, template: ${template || 'standard'}):

HEADLINE: ${extractedData.headline || 'Not found'}

SUBHEADLINE: ${extractedData.subheadline || 'Not found'}

CTA BUTTONS: ${extractedData.cta.join(', ') || 'Not found'}

PRICE: ${extractedData.price || 'Not found'}

BENEFITS/KEY POINTS:
${extractedData.benefits.slice(0, 5).map((b, i) => `${i + 1}. ${b}`).join('\n') || 'Not found'}

Provide a detailed analysis including:
1. Headline evaluation (score 1-10 and suggestions)
2. CTA effectiveness
3. Copy structure
4. Strengths
5. Areas for improvement
6. Specific suggestions to optimize conversion`;

    // Call the copy_analyzer API (timeout 30s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let analyzerResponse: Response;
    try {
      analyzerResponse = await fetch(
        'https://claude-code-agents.fly.dev/api/agent/run/copy_analyzer',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
          signal: controller.signal,
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeout);
      const msg = fetchErr instanceof Error ? fetchErr.message : 'Error';
      if (msg.includes('abort')) {
        return NextResponse.json(
          { error: 'Timeout: external copy_analyzer API did not respond within 30 seconds' },
          { status: 504 }
        );
      }
      return NextResponse.json(
        { error: `Unable to reach copy_analyzer: ${msg}` },
        { status: 503 }
      );
    }
    clearTimeout(timeout);

    if (!analyzerResponse.ok) {
      return NextResponse.json(
        { error: `API analyzer error: ${analyzerResponse.status}` },
        { status: 500 }
      );
    }

    const analysisResult = await analyzerResponse.json();

    return NextResponse.json({
      url,
      pageType,
      template,
      extractedData,
      analysis: analysisResult,
    });
  } catch (error) {
    console.error('Error during funnel analysis:', error);
    return NextResponse.json(
      { error: 'Error during funnel analysis' },
      { status: 500 }
    );
  }
}
