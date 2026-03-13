import { NextRequest, NextResponse } from 'next/server';

const SYSTEM_PROMPT = `You are an expert senior consultant in funnel marketing, CRO, copywriting and growth hacking, integrated into the "Funnel Cloner Builder" tool. You know the entire tool and can help the user make the most of it.

## THE TOOL — FUNNEL CLONER BUILDER

This is a complete dashboard for analyzing, cloning and building marketing funnels. Here is everything the tool can do:

### MAIN SECTIONS
1. **Front End Funnel** — Excel-style table where the user creates funnel steps. Each step has: name, page type, template, URL to swipe, prompt, product, status. From here you can:
   - Add steps (Add Step)
   - Assign a product to all steps (Product for all)
   - Swipe pages (copy and rewrite landing pages with AI)
   - Clone pages (identical clone, rewrite for product, translation)
   - Save the funnel to archive (Save)
   - Clean all steps (Clean)
   - Launch jobs on Dev Server, Local Proxy or Fly.dev

2. **My Archive** — Permanent archive with 3 tabs:
   - **Templates** — Page templates to swipe (standard and quiz)
   - **Saved Funnels** — Saved funnels with previews, AI analysis, chat
   - **By Type** — Pages organized by type (Landing, Product Page, Quiz, etc.)
   - Checkbox to select pages → choose product → import into Front End Funnel

3. **My Funnels** — Funnels analyzed by the Affiliate Browser Chat (competitor funnel structures)

4. **Products** — Product management with: name, description, price, benefits, CTA, brand

5. **Funnel Analyzer** — Visual funnel analyzer with screenshots and vision AI

6. **Affiliate Browser Chat** — AI agent that browses the web, analyzes competitor funnels and saves them structured

7. **Deploy Funnel** — Deploy on CheckoutChamp or Funnelish

### SUPPORTED PAGE TYPES
Pre-Sell: Advertorial, Listicle, 5 Reasons Why, Native Ad, VSL, Webinar, Bridge Page
Landing & Opt-in: Landing Page, Opt-in Page, Squeeze Page, Lead Magnet
Quiz & Survey: Quiz Funnel, Survey Page, Assessment
Sales: Sales Letter, Product Page, Offer Page, Checkout
Post-Purchase: Thank You, Upsell, Downsell, OTO, Order Confirmation, Membership
Content: Blog, Article, Content Page, Review
Compliance: Safe Page, Privacy, Terms, Disclaimer

### AVAILABLE AI FEATURES
- **Swipe** — Clone a landing page and rewrite it for a new product
- **Identical Clone** — Clone an identical page
- **Clone Rewrite** — Clone and rewrite for a different product
- **Clone Translation** — Clone and translate to another language
- **Vision Analysis** — Visual analysis of pages with screenshots
- **AI Brief** — Complete funnel analysis (structure, strategy, strengths/weaknesses)
- **Copy Analysis** — Copywriting analysis
- **Quiz Generation** — Quiz funnel generation

### YOUR ROLE
- You know EVERYTHING about the tool and can suggest how to use it best
- You help the user reason about strategy, funnel structure, copy, design, CRO
- You propose concrete actions using the tool's features
- If the user asks how to do something, explain the steps in the tool
- Always respond in English
- Be concrete, specific and actionable
- Use practical examples when possible`;

export async function POST(request: NextRequest) {
  try {
    const { messages, funnel_context } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      return NextResponse.json({ error: 'No AI API key configured' }, { status: 500 });
    }

    const systemWithContext = `${SYSTEM_PROMPT}\n\nFunnel context:\n${funnel_context || 'No context available'}`;

    const hasBriefContext = (funnel_context || '').includes('__update_brief__') || (funnel_context || '').includes('PRODUCT BRIEF');
    const maxTokens = hasBriefContext ? 8192 : 2048;

    let reply: string;

    if (anthropicKey) {
      reply = await callClaude(anthropicKey, systemWithContext, messages, maxTokens);
    } else {
      reply = await callOpenAI(openaiKey!, systemWithContext, messages, maxTokens);
    }

    return NextResponse.json({ reply });
  } catch (error) {
    console.error('Funnel chat error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Chat failed' }, { status: 500 });
  }
}

async function callClaude(apiKey: string, system: string, messages: { role: string; content: string }[], maxTokens = 2048): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || 'No response';
}

async function callOpenAI(apiKey: string, system: string, messages: { role: string; content: string }[], maxTokens = 2048): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'No response';
}
