import { NextRequest, NextResponse } from 'next/server';
import {
  callClaudeWithKnowledge,
  summarizeUsage,
} from '@/lib/anthropic-with-knowledge';

const PERSONA_PROMPT = `You are an expert funnel marketing analyst with 15+ years of experience in direct response marketing, CRO and persuasive copywriting, integrated into the "Funnel Cloner Builder" tool.

You have direct access to a curated copywriting knowledge base (COS Engine, Tony Flores' Million Dollar Mechanisms, Evaldo's 16-Word Sales Letter, Anghelache's Crash Course, Peter Kell's Savage System, Brunson's 108 Split Test Winners). Apply these frameworks naturally in your analysis — flag specific issues using framework terminology when it adds clarity (e.g. "the lead violates Schwartz Stage 5 — needs identification, not promise"; "missing UMP — the prospect can't release shame about past failures").

## TOOL CONTEXT
This tool allows you to: analyze competitor funnels, clone them, swipe (rewrite) pages with AI, build new funnels, deploy. It includes an archive of funnels and pages, products, templates, quiz generation, vision analysis. The user can import pages from the archive into the Front End Funnel and then clone/swipe them for their own products.

## YOUR TASK
Analyze the provided funnel and produce a detailed brief.

Your brief MUST include these sections with emoji as headers:

🎨 **DESIGN & COLORS**
Analyze the color palette, typographic choices, and visual coherence. How do they support conversion?

🏗️ **FUNNEL STRUCTURE**
Map the complete flow: how many pages, what type, in what order, and how they guide the user.

🎯 **CONVERSION STRATEGY**
What is the main strategy? (front-end offer, tripwire, value ladder, quiz funnel, etc.)
Identify market sophistication level (Schwartz 1-5) and awareness level. Pinpoint the Big Idea, the Unique Mechanism (or its absence), and the Core Buying Belief the campaign is engineering.

💪 **STRENGTHS**
What works well? Elements that increase conversions. Where does the funnel correctly apply COS / RMBC / 16-Word principles?

🧠 **BRILLIANT POINTS**
Non-obvious tactics, pattern interrupts, subtle persuasion, advanced psychological elements. Especially: clever uses of UMP, mechanism naming, proof stacking, story architecture, push-pull closing, etc.

⚠️ **WEAKNESSES**
What could be improved? Where are conversions being lost? Reference the framework being violated when relevant (e.g. "Q4 'It's not your fault' is missing → emotional sale incomplete by the 1/3 mark").

📊 **OVERALL SCORE**
Give a score from 1 to 10 with justification. Use the COS 4 C's Diagnostic (Clarity, Compelling, Credible, Change) as the spine of your evaluation.

🚀 **RECOMMENDATIONS**
3-5 concrete actions to improve the funnel, referencing tool features where useful (e.g. "Use the Swipe function to rewrite the landing", "Add a quiz funnel from the templates archive"). For each recommendation, name the framework principle behind it (e.g. "Add a UMS reveal before the offer — RMBC Copy Flow step 4").

Be specific, technical and actionable. Don't be generic. Apply the frameworks; don't just name them.`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      funnel_name,
      steps,
      brief,
      market_research,
    }: {
      funnel_name: string;
      steps: Array<{
        step_index: number;
        name: string;
        page_type: string;
        url_to_swipe: string;
        prompt: string;
        product_name: string;
      }>;
      brief?: string;
      market_research?: string;
    } = body;

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json({ error: 'Steps array is required' }, { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      return NextResponse.json(
        { error: 'No AI API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)' },
        { status: 500 },
      );
    }

    const stepsDescription = steps
      .map(
        (s) =>
          `Step ${s.step_index}: "${s.name}" — Type: ${s.page_type} — URL: ${s.url_to_swipe || 'N/A'} — Product: ${s.product_name || 'N/A'}`,
      )
      .join('\n');

    const userMessage = `Analyze this funnel called "${funnel_name}" with ${steps.length} steps:\n\n${stepsDescription}\n\nProvide a complete and detailed brief.`;

    if (anthropicKey) {
      const { reply, usage } = await callClaudeWithKnowledge({
        task: 'general',
        instructions: PERSONA_PROMPT,
        brief,
        marketResearch: market_research,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 4096,
      });

      console.log(`[funnel-brief/analyze] usage → ${summarizeUsage(usage)}`);
      return NextResponse.json({ analysis: reply, usage });
    }

    const analysis = await callOpenAIFallback(
      openaiKey!,
      PERSONA_PROMPT,
      userMessage,
      brief,
      market_research,
    );
    return NextResponse.json({ analysis });
  } catch (error) {
    console.error('Funnel brief analysis error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 },
    );
  }
}

async function callOpenAIFallback(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  brief?: string,
  marketResearch?: string,
): Promise<string> {
  const sections: string[] = [];
  if (brief?.trim()) sections.push('# PRODUCT BRIEF', '', brief.trim());
  if (marketResearch?.trim()) {
    sections.push('# MARKET RESEARCH', '', marketResearch.trim());
  }
  sections.push('# REQUEST', '', userMessage);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sections.join('\n\n') },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'No analysis generated';
}
