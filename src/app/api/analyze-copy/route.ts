import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function extractPageContent(html: string) {
  // Remove script and style tags
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Extract headline (h1)
  let headline = '';
  const h1Match = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    headline = h1Match[1].replace(/<[^>]*>/g, '').trim();
  }

  // Extract sub-headlines (h2)
  const subHeadlines: string[] = [];
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let h2Match;
  while ((h2Match = h2Regex.exec(cleaned)) !== null) {
    const text = h2Match[1].replace(/<[^>]*>/g, '').trim();
    if (text) subHeadlines.push(text);
  }

  // Extract h3s
  const h3s: string[] = [];
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let h3Match;
  while ((h3Match = h3Regex.exec(cleaned)) !== null) {
    const text = h3Match[1].replace(/<[^>]*>/g, '').trim();
    if (text) h3s.push(text);
  }

  // Extract meta description
  let metaDescription = '';
  const metaMatch = cleaned.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  if (metaMatch) {
    metaDescription = metaMatch[1].trim();
  }

  // Extract title
  let title = '';
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
  }

  // Extract CTA buttons text
  const ctaTexts: string[] = [];
  const buttonRegex = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let btnMatch;
  while ((btnMatch = buttonRegex.exec(cleaned)) !== null) {
    const text = btnMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text && text.length < 100) ctaTexts.push(text);
  }
  // Also check for <a> tags with common CTA classes
  const ctaLinkRegex = /<a[^>]*class="[^"]*(?:btn|button|cta)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let ctaMatch;
  while ((ctaMatch = ctaLinkRegex.exec(cleaned)) !== null) {
    const text = ctaMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text && text.length < 100) ctaTexts.push(text);
  }

  // Extract all visible text (limited to avoid token overflow)
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let bodyText = '';
  if (bodyMatch) {
    bodyText = bodyMatch[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    bodyText = cleaned
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Limit body text to ~4000 chars to stay within token limits
  if (bodyText.length > 4000) {
    bodyText = bodyText.substring(0, 4000) + '...';
  }

  return {
    title,
    headline: headline || title,
    subHeadlines: subHeadlines.slice(0, 10),
    h3s: h3s.slice(0, 10),
    metaDescription,
    ctaTexts: Array.from(new Set(ctaTexts)).slice(0, 10),
    bodyText,
  };
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured on the server' },
        { status: 500 }
      );
    }

    // Fetch the page
    const pageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
      },
      redirect: 'follow',
    });

    if (!pageResponse.ok) {
      return NextResponse.json(
        { error: `Unable to load the page: ${pageResponse.status} ${pageResponse.statusText}` },
        { status: 400 }
      );
    }

    const html = await pageResponse.text();
    const pageContent = extractPageContent(html);

    if (!pageContent.bodyText && !pageContent.headline) {
      return NextResponse.json(
        { error: 'No text content found on the page' },
        { status: 400 }
      );
    }

    // Build the prompt for Claude
    const analysisPrompt = `You are an expert in copywriting and direct marketing. Analyze the following landing page and provide a detailed analysis.

**URL:** ${url}

**Page Title:** ${pageContent.title || 'N/A'}

**Main Headline (H1):** ${pageContent.headline || 'Not found'}

**Sub-headlines (H2):**
${pageContent.subHeadlines.length > 0 ? pageContent.subHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None found'}

**H3:**
${pageContent.h3s.length > 0 ? pageContent.h3s.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None found'}

**Meta Description:** ${pageContent.metaDescription || 'N/A'}

**CTA Texts (buttons):**
${pageContent.ctaTexts.length > 0 ? pageContent.ctaTexts.map((c, i) => `${i + 1}. "${c}"`).join('\n') : 'None found'}

**Visible Page Text:**
${pageContent.bodyText}

---

Provide a structured analysis with the following points:

1. **Overall Score** (1 to 10): Rate the overall quality of the copy.

2. **Headline Analysis**: 
   - Is the headline clear and understandable?
   - Does it communicate a specific benefit?
   - Does it create urgency or curiosity?
   - Suggestions for improvement

3. **Value Proposition**: 
   - Is the value proposition clear?
   - Does it differentiate from the competition?

4. **CTA (Call to Action)**:
   - Are the CTAs clear and persuasive?
   - Suggestions for improvement

5. **Copy Structure**:
   - Is the logical flow effective?
   - Is the information hierarchy correct?

6. **Persuasion Techniques**:
   - Which persuasion techniques are used? (social proof, scarcity, authority, etc.)
   - Which are missing and could be added?

7. **Strengths**: List of the best points of the copy

8. **Areas for Improvement**: List of weak points with concrete suggestions

9. **3 Alternative Headlines**: Propose 3 potentially more effective alternative headlines

Reply in English.`;

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: analysisPrompt,
        },
      ],
    });

    // Extract text from response
    const analysisText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => {
        if (block.type === 'text') return block.text;
        return '';
      })
      .join('\n');

    return NextResponse.json({
      headline: pageContent.headline,
      url,
      pageContent: {
        title: pageContent.title,
        subHeadlines: pageContent.subHeadlines,
        ctaTexts: pageContent.ctaTexts,
        metaDescription: pageContent.metaDescription,
      },
      analysis: {
        status: 'completed',
        result: analysisText,
        model: message.model,
        usage: message.usage,
      },
    });
  } catch (error) {
    console.error('Error during analysis:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Error during page analysis: ${errorMessage}` },
      { status: 500 }
    );
  }
}
