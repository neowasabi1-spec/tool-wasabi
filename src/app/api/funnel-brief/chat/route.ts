import { NextRequest, NextResponse } from 'next/server';
import {
  callClaudeWithKnowledge,
  summarizeUsage,
  type ClaudeMessage,
} from '@/lib/anthropic-with-knowledge';
import type { CopywritingTask } from '@/knowledge/copywriting';

const PERSONA_PROMPT = `You are an expert senior consultant in funnel marketing, CRO, copywriting and growth hacking, integrated into the "Funnel Cloner Builder" tool. You know the entire tool and can help the user make the most of it.

You have direct access to a curated knowledge base of direct-response copywriting frameworks (COS Engine, Tony Flores' Million Dollar Mechanisms, Evaldo's 16-Word Sales Letter, Anghelache's Crash Course, Peter Kell's Savage System, Brunson's 108 Split Test Winners). Apply these frameworks naturally — only cite them by name when explicitly asked or when it materially helps the user understand a recommendation.

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
- Use practical examples when possible
- Apply COS / RMBC / 16-Word / Mechanism frameworks silently to ground your advice in proven principles`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      messages,
      funnel_context,
      brief,
      market_research,
      task,
      use_knowledge,
    }: {
      messages: ClaudeMessage[];
      funnel_context?: string;
      brief?: string;
      market_research?: string;
      task?: CopywritingTask;
      use_knowledge?: boolean;
    } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Messages array is required' },
        { status: 400 },
      );
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      return NextResponse.json(
        { error: 'No AI API key configured' },
        { status: 500 },
      );
    }

    // Funnel context is appended to instructions; it changes per funnel so we
    // include it but it stays inside the cached system block (cache key
    // depends on full text — when context changes the cache misses, which
    // is expected).
    const instructions =
      funnel_context && funnel_context.trim().length > 0
        ? `${PERSONA_PROMPT}\n\n## CURRENT FUNNEL CONTEXT\n${funnel_context}`
        : PERSONA_PROMPT;

    const hasBriefContext =
      (brief?.length ?? 0) > 0 ||
      (market_research?.length ?? 0) > 0 ||
      (funnel_context || '').includes('__update_brief__') ||
      (funnel_context || '').includes('PRODUCT BRIEF');
    const maxTokens = hasBriefContext ? 8192 : 2048;

    if (anthropicKey) {
      const { reply, usage } = await callClaudeWithKnowledge({
        task: task ?? 'general',
        instructions,
        brief,
        marketResearch: market_research,
        messages,
        maxTokens,
        skipKnowledge: use_knowledge === false,
      });

      console.log(`[funnel-brief/chat] usage → ${summarizeUsage(usage)}`);

      return NextResponse.json({ reply, usage });
    }

    // OpenAI fallback (no KB injection, kept simple — historical behavior)
    const reply = await callOpenAIFallback(
      openaiKey!,
      instructions,
      brief,
      market_research,
      messages,
      maxTokens,
    );
    return NextResponse.json({ reply });
  } catch (error) {
    console.error('Funnel chat error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Chat failed' },
      { status: 500 },
    );
  }
}

async function callOpenAIFallback(
  apiKey: string,
  instructions: string,
  brief: string | undefined,
  marketResearch: string | undefined,
  messages: ClaudeMessage[],
  maxTokens: number,
): Promise<string> {
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const wrappedMessages = [...messages];
  if (last?.role === 'user' && (brief || marketResearch)) {
    const sections: string[] = [];
    if (brief?.trim()) sections.push('# PRODUCT BRIEF', '', brief.trim());
    if (marketResearch?.trim()) {
      sections.push('# MARKET RESEARCH', '', marketResearch.trim());
    }
    sections.push('# REQUEST', '', last.content);
    wrappedMessages[lastIdx] = { role: 'user', content: sections.join('\n\n') };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: instructions },
        ...wrappedMessages,
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
