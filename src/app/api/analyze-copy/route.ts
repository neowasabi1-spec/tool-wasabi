import { NextRequest, NextResponse } from 'next/server';
import {
  callClaudeWithKnowledge,
  summarizeUsage,
} from '@/lib/anthropic-with-knowledge';

const PERSONA_PROMPT = `You are an expert in copywriting and direct response marketing. You have direct access to a curated knowledge base of frameworks (COS Engine, Tony Flores' Million Dollar Mechanisms, Evaldo's 16-Word Sales Letter, Anghelache's Crash Course, Peter Kell's Savage System, Brunson's 108 Split Test Winners). Apply them naturally — name the principle when it materially helps the user understand a recommendation, otherwise just use it.

Be specific, technical, actionable. Use framework terminology where it adds clarity (e.g. "the lead is direct-promise but the market is Stage 5 — needs identification, not promise"; "Q4 'It's not your fault' is absent — past failures aren't released, blocking emotional momentum"). Avoid generic copywriting platitudes.`;

interface PageContent {
  title: string;
  headline: string;
  subHeadlines: string[];
  h3s: string[];
  metaDescription: string;
  ctaTexts: string[];
  bodyText: string;
}

function extractPageContent(html: string): PageContent {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  let headline = '';
  const h1Match = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) headline = h1Match[1].replace(/<[^>]*>/g, '').trim();

  const subHeadlines: string[] = [];
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  let h2Match: RegExpExecArray | null;
  while ((h2Match = h2Regex.exec(cleaned)) !== null) {
    const text = h2Match[1].replace(/<[^>]*>/g, '').trim();
    if (text) subHeadlines.push(text);
  }

  const h3s: string[] = [];
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let h3Match: RegExpExecArray | null;
  while ((h3Match = h3Regex.exec(cleaned)) !== null) {
    const text = h3Match[1].replace(/<[^>]*>/g, '').trim();
    if (text) h3s.push(text);
  }

  let metaDescription = '';
  const metaMatch = cleaned.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
  );
  if (metaMatch) metaDescription = metaMatch[1].trim();

  let title = '';
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/<[^>]*>/g, '').trim();

  const ctaTexts: string[] = [];
  const buttonRegex = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let btnMatch: RegExpExecArray | null;
  while ((btnMatch = buttonRegex.exec(cleaned)) !== null) {
    const text = btnMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text && text.length < 100) ctaTexts.push(text);
  }
  const ctaLinkRegex = /<a[^>]*class="[^"]*(?:btn|button|cta)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let ctaMatch: RegExpExecArray | null;
  while ((ctaMatch = ctaLinkRegex.exec(cleaned)) !== null) {
    const text = ctaMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text && text.length < 100) ctaTexts.push(text);
  }

  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let bodyText = '';
  if (bodyMatch) {
    bodyText = bodyMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  } else {
    bodyText = cleaned.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (bodyText.length > 4000) bodyText = bodyText.substring(0, 4000) + '...';

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

function buildAnalysisPrompt(url: string, p: PageContent): string {
  return `Analyze the following landing page and provide a detailed structured analysis.

**URL:** ${url}

**Page Title:** ${p.title || 'N/A'}

**Main Headline (H1):** ${p.headline || 'Not found'}

**Sub-headlines (H2):**
${p.subHeadlines.length > 0 ? p.subHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None found'}

**H3:**
${p.h3s.length > 0 ? p.h3s.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None found'}

**Meta Description:** ${p.metaDescription || 'N/A'}

**CTA Texts (buttons):**
${p.ctaTexts.length > 0 ? p.ctaTexts.map((c, i) => `${i + 1}. "${c}"`).join('\n') : 'None found'}

**Visible Page Text:**
${p.bodyText}

---

Provide a structured analysis with the following points:

1. **Overall Score** (1 to 10): Rate the overall quality of the copy using the COS 4 C's Diagnostic (Clarity, Compelling, Credible, Change).

2. **Market Diagnosis**:
   - Estimated Schwartz sophistication level (1-5) and reasoning
   - Estimated awareness level and reasoning
   - Implied Dominant Resident Emotion (DRE)

3. **Headline Analysis** (apply 4U Scoring + 13 Headline Boosters):
   - Score each U (Useful / Unique / Ultra-Specific / Urgent) 1-4
   - Total /16 — anything below 12 needs rewrite
   - Is there a Big Idea? Is there a Unique Mechanism hint?
   - Concrete suggestions for improvement

4. **Lead Type & Awareness Match**:
   - Which of the 6 Lead Types is being used? (Offer / Direct Promise / Problem-Solution / Secrets-Systems / Prediction / Story)
   - Does it match the awareness level identified above?

5. **Value Proposition & UMP/UMS**:
   - Is there a Unique Mechanism of the Problem (UMP)? "It's not your fault" framing?
   - Is there a Unique Mechanism of the Solution (UMS)?
   - Is the Core Buying Belief explicit?

6. **CTA (Call to Action)**:
   - Clear and persuasive?
   - Push-pull (Q10) or needy?
   - Suggestions

7. **Persuasion Techniques in Use**:
   - Which behavioral biases are leveraged (loss aversion, scarcity, authority, social proof, curiosity gap, etc.)?
   - Which proof types are stacked (12 Power Proof Elements)?
   - Which are MISSING and could be added?

8. **Copy Structure & Flow**:
   - Does it follow RMBC Copy Flow (Lead → Story → UMP → UMS → Product → Close)?
   - Where does it break the flow?

9. **Strengths**: List of the best points.

10. **Areas for Improvement**: List of weak points with concrete, framework-grounded suggestions.

11. **3 Alternative Headlines** built using different frameworks (e.g. one Direct Promise, one Curiosity-Gap, one Story-based).

Reply in English.`;
}

export async function POST(request: NextRequest) {
  try {
    const {
      url,
      brief,
      market_research,
    }: {
      url: string;
      brief?: string;
      market_research?: string;
    } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured on the server' },
        { status: 500 },
      );
    }

    const pageResponse = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
      },
      redirect: 'follow',
    });

    if (!pageResponse.ok) {
      return NextResponse.json(
        {
          error: `Unable to load the page: ${pageResponse.status} ${pageResponse.statusText}`,
        },
        { status: 400 },
      );
    }

    const html = await pageResponse.text();
    const pageContent = extractPageContent(html);

    if (!pageContent.bodyText && !pageContent.headline) {
      return NextResponse.json(
        { error: 'No text content found on the page' },
        { status: 400 },
      );
    }

    const analysisPrompt = buildAnalysisPrompt(url, pageContent);

    const { reply, usage, model } = await callClaudeWithKnowledge({
      task: 'general',
      instructions: PERSONA_PROMPT,
      brief,
      marketResearch: market_research,
      messages: [{ role: 'user', content: analysisPrompt }],
      maxTokens: 4096,
    });

    console.log(`[analyze-copy] usage → ${summarizeUsage(usage)}`);

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
        result: reply,
        model,
        usage,
      },
    });
  } catch (error) {
    console.error('Error during analysis:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Error during page analysis: ${errorMessage}` },
      { status: 500 },
    );
  }
}
