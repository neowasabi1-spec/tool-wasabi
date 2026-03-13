import { NextRequest, NextResponse } from 'next/server';

const SYSTEM_PROMPT = `You are an expert funnel marketing analyst with 15+ years of experience in direct response marketing, CRO and persuasive copywriting, integrated into the "Funnel Cloner Builder" tool.

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

💪 **STRENGTHS**
What works well? Elements that increase conversions.

🧠 **BRILLIANT POINTS**
Non-obvious tactics, pattern interrupts, subtle persuasion, advanced psychological elements.

⚠️ **WEAKNESSES**
What could be improved? Where are conversions being lost?

📊 **OVERALL SCORE**
Give a score from 1 to 10 with justification.

🚀 **RECOMMENDATIONS**
3-5 concrete actions to improve the funnel, referencing tool features where useful (e.g. "Use the Swipe function to rewrite the landing", "Add a quiz funnel from the templates archive").

Be specific, technical and actionable. Don't be generic.`;

export async function POST(request: NextRequest) {
  try {
    const { funnel_name, steps } = await request.json();

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json({ error: 'Steps array is required' }, { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      return NextResponse.json({ error: 'No AI API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY)' }, { status: 500 });
    }

    const stepsDescription = steps.map((s: { step_index: number; name: string; page_type: string; url_to_swipe: string; prompt: string; product_name: string }) =>
      `Step ${s.step_index}: "${s.name}" — Type: ${s.page_type} — URL: ${s.url_to_swipe || 'N/A'} — Product: ${s.product_name || 'N/A'}`
    ).join('\n');

    const userMessage = `Analyze this funnel called "${funnel_name}" with ${steps.length} steps:\n\n${stepsDescription}\n\nProvide a complete and detailed brief.`;

    let analysis: string;

    if (anthropicKey) {
      analysis = await callClaude(anthropicKey, userMessage);
    } else {
      analysis = await callOpenAI(openaiKey!, userMessage);
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error('Funnel brief analysis error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Analysis failed' }, { status: 500 });
  }
}

async function callClaude(apiKey: string, userMessage: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || 'No analysis generated';
}

async function callOpenAI(apiKey: string, userMessage: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
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
