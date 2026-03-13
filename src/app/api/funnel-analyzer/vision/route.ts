import { NextRequest, NextResponse } from 'next/server';
import type { FunnelCrawlStep, FunnelPageVisionAnalysis, FunnelPageType } from '@/types';

const VISION_PROMPT = `Analyze this funnel page (screenshot). Return ONLY a valid JSON object, without markdown or code blocks, with exactly these keys (use null for missing strings and empty arrays [] where appropriate):
- page_type: one of: "opt-in", "vsl", "sales_page", "order_form", "upsell", "downsell", "thank_you", "bridge_page", "landing", "checkout", "other"
- headline: string or null
- subheadline: string or null
- body_copy: main text (extracted) or null
- cta_text: array of button/CTA texts (all visible CTAs)
- next_step_ctas: array of main CTAs that lead to the next funnel step (e.g. "Buy Now", "Go to checkout", "Continue", "Sign up") — exclude secondary links like privacy, cookie, go back
- offer_details: offer description or null
- price_points: array of detected prices/price texts
- urgency_elements: array (e.g. "deadline", "limited spots", countdown)
- social_proof: array (testimonials, numbers, logos)
- tech_stack_detected: array (e.g. ClickFunnels, Shopify, Stripe, Mailchimp - from layout/scripts)
- outbound_links: array of main destinations (e.g. checkout URL, privacy)
- persuasion_techniques_used: array (e.g. "scarcity", "authority", "risk reversal")`;

const PAGE_TYPES: FunnelPageType[] = [
  'opt-in', 'vsl', 'sales_page', 'order_form', 'upsell', 'downsell',
  'thank_you', 'bridge_page', 'landing', 'checkout', 'other',
];

function parseJsonFromResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeAnalysis(
  step: FunnelCrawlStep,
  raw: Record<string, unknown>
): FunnelPageVisionAnalysis {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const pageType = typeof raw.page_type === 'string' && PAGE_TYPES.includes(raw.page_type as FunnelPageType)
    ? (raw.page_type as FunnelPageType)
    : 'other';

  return {
    stepIndex: step.stepIndex,
    url: step.url,
    page_type: pageType,
    headline: str(raw.headline),
    subheadline: str(raw.subheadline),
    body_copy: str(raw.body_copy),
    cta_text: arr(raw.cta_text),
    next_step_ctas: arr(raw.next_step_ctas),
    offer_details: str(raw.offer_details),
    price_points: arr(raw.price_points),
    urgency_elements: arr(raw.urgency_elements),
    social_proof: arr(raw.social_proof),
    tech_stack_detected: arr(raw.tech_stack_detected),
    outbound_links: arr(raw.outbound_links),
    persuasion_techniques_used: arr(raw.persuasion_techniques_used),
  };
}

async function analyzeWithClaude(
  screenshotBase64: string,
  context: string,
  apiKey: string
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshotBase64,
              },
            },
            {
              type: 'text',
              text: `${VISION_PROMPT}\n\nContext: ${context}`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return text;
}

async function analyzeWithGemini(
  screenshotBase64: string,
  context: string,
  apiKey: string
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: 'image/png',
                  data: screenshotBase64,
                },
              },
              { text: `${VISION_PROMPT}\n\nContext: ${context}` },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.2,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { steps, provider } = body as {
      steps: FunnelCrawlStep[];
      provider: 'claude' | 'gemini';
    };

    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json(
        { success: false, error: 'steps array is required and must not be empty' },
        { status: 400 }
      );
    }

    const rawClaude = (process.env.ANTHROPIC_API_KEY ?? '').trim();
    const rawGemini = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();
    const apiKey = provider === 'claude' ? rawClaude : rawGemini;

    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: provider === 'claude'
            ? 'Missing key: add ANTHROPIC_API_KEY in .env.local (in the project root) and restart the server (npm run dev).'
            : 'Missing key: add GOOGLE_GEMINI_API_KEY (or GEMINI_API_KEY) in .env.local (in the project root) and restart the server (npm run dev).',
        },
        { status: 400 }
      );
    }

    const analyses: FunnelPageVisionAnalysis[] = [];
    const errors: string[] = [];

    for (const step of steps) {
      if (!step.screenshotBase64) {
        analyses.push({
          stepIndex: step.stepIndex,
          url: step.url,
          page_type: 'other',
          headline: null,
          subheadline: null,
          body_copy: null,
          cta_text: [],
          next_step_ctas: [],
          offer_details: null,
          price_points: [],
          urgency_elements: [],
          social_proof: [],
          tech_stack_detected: [],
          outbound_links: [],
          persuasion_techniques_used: [],
          error: 'No screenshot for this step',
        });
        continue;
      }

      const context = `URL: ${step.url}. Title: ${step.title}. CTAs from crawl: ${step.ctaButtons.map((b) => b.text).join(', ')}.`;

      try {
        const rawText =
          provider === 'claude'
            ? await analyzeWithClaude(step.screenshotBase64, context, apiKey)
            : await analyzeWithGemini(step.screenshotBase64, context, apiKey);

        const parsed = parseJsonFromResponse(rawText);
        if (parsed) {
          analyses.push(normalizeAnalysis(step, parsed));
        } else {
        analyses.push({
          ...normalizeAnalysis(step, { next_step_ctas: [] }),
          raw: rawText.slice(0, 500),
          error: 'Could not parse JSON from model',
        });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Step ${step.stepIndex}: ${msg}`);
        analyses.push({
          stepIndex: step.stepIndex,
          url: step.url,
          page_type: 'other',
          headline: null,
          subheadline: null,
          body_copy: null,
          cta_text: [],
          next_step_ctas: [],
          offer_details: null,
          price_points: [],
          urgency_elements: [],
          social_proof: [],
          tech_stack_detected: [],
          outbound_links: [],
          persuasion_techniques_used: [],
          error: msg,
        });
      }
    }

    return NextResponse.json({
      success: errors.length < steps.length,
      analyses,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Funnel vision error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Vision analysis failed',
      },
      { status: 500 }
    );
  }
}
