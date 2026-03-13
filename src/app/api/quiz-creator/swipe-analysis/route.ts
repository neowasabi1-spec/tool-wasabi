import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

type Phase = 'my-branding' | 'swipe-regenerate';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
}

async function callClaude(
  messages: ClaudeMessage[],
  apiKey: string,
  maxTokens: number = 8192,
  system?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages,
  };
  if (system) body.system = system;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content?: { type: string; text?: string }[];
  };
  return data.content?.find((c) => c.type === 'text')?.text ?? '';
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── Phase 1: MY BRANDING ────────────────────────────────────────────────────
// Claude takes the screenshot + original analysis + user's product info
// and generates personalized branding for the user's product
function buildMyBrandingMessages(
  screenshot: string,
  originalAnalysis: Record<string, unknown>,
  productInfo: {
    product_name: string;
    product_description: string;
    target_audience: string;
    industry: string;
    tone_of_voice: string;
    unique_selling_points: string;
  }
): { messages: ClaudeMessage[]; system: string } {
  const system = `You are an expert in branding, marketing and strategic design.
Your task is to analyze a competitor/inspiration design (screenshot + analysis) and create PERSONALIZED branding for the user's product.

You must not copy, you must SWIPE: take inspiration from the structure and best practices of the competitor, but adapt everything to the user's brand with its own colors, tone and personality.

RESPOND ONLY with a valid JSON object, no markdown, no code blocks.`;

  const prompt = `Analyze this screenshot and the branding analysis of a competitor/inspiration, then create PERSONALIZED branding for my product.

═══ ORIGINAL ANALYSIS (COMPETITOR/INSPIRATION) ═══
${JSON.stringify(originalAnalysis, null, 2)}

═══ MY PRODUCT ═══
Name: ${productInfo.product_name}
Description: ${productInfo.product_description}
Target Audience: ${productInfo.target_audience}
Industry: ${productInfo.industry}
Tone of Voice: ${productInfo.tone_of_voice}
Unique Selling Points (USP): ${productInfo.unique_selling_points}

═══ INSTRUCTIONS ═══
Generate a JSON with this EXACT structure for MY brand (not the competitor's):

{
  "brand_identity": {
    "brand_name": "${productInfo.product_name}",
    "brand_personality": "MY brand's personality",
    "brand_voice": "specific tone of voice",
    "brand_promise": "brand promise to the customer",
    "target_audience": "detailed description of MY target",
    "industry": "${productInfo.industry}",
    "positioning_statement": "brand positioning in the market",
    "competitor_differentiation": "how I differentiate from the analyzed competitor"
  },
  "color_palette": {
    "primary_color": "#hex - MY brand's primary color",
    "secondary_color": "#hex",
    "accent_color": "#hex - for CTA and accent elements",
    "background_color": "#hex",
    "text_color": "#hex",
    "gradient_primary": "linear-gradient(...) for premium elements",
    "all_colors": ["all hex colors of MY brand"],
    "color_rationale": "why I chose these colors for this brand"
  },
  "typography": {
    "heading_font": "Google Fonts font name for headings",
    "body_font": "Google Fonts font name for body",
    "heading_weight": "heading font weight (e.g. 700)",
    "body_weight": "body font weight (e.g. 400)",
    "font_rationale": "why these fonts communicate the brand"
  },
  "visual_style": {
    "overall_aesthetic": "overall aesthetic (e.g. minimal, bold, elegant, playful)",
    "border_radius": "px value for corners",
    "shadow_style": "shadow style (e.g. subtle, pronounced, none)",
    "spacing_feel": "spacing feel (generous, balanced, compact)",
    "imagery_direction": "art direction for images",
    "icon_style": "icon style (outlined, filled, duotone)"
  },
  "messaging": {
    "headline_formula": "headline formula (e.g. [Result] without [Problem])",
    "value_proposition": "value proposition in one sentence",
    "key_benefits": ["benefit 1", "benefit 2", "benefit 3"],
    "social_proof_approach": "how to use social proof",
    "urgency_strategy": "urgency/scarcity strategy",
    "cta_primary_text": "primary CTA text",
    "cta_secondary_text": "secondary CTA text"
  },
  "quiz_strategy": {
    "quiz_hook": "quiz hook (why the user should take it)",
    "quiz_title": "quiz title",
    "quiz_subtitle": "quiz subtitle",
    "question_themes": ["question theme 1", "question theme 2", "..."],
    "result_types": ["result type 1", "result type 2", "..."],
    "lead_magnet_angle": "angle for email capture",
    "conversion_strategy": "post-quiz conversion strategy"
  },
  "swipe_notes": {
    "what_i_kept_from_original": ["what I took from the original"],
    "what_i_changed": ["what I changed and why"],
    "improvement_opportunities": ["improvement opportunities compared to the original"]
  }
}

IMPORTANT:
- Colors must be DIFFERENT from the original, specific to MY brand
- The tone must reflect MY product, not the competitor's
- Take inspiration from the STRUCTURE and BEST PRACTICES, not from literal branding
- Quiz questions must be relevant to MY industry and target`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

// ─── Phase 2: SWIPE REGENERATE ───────────────────────────────────────────────
// Claude takes my product's branding + the original analysis
// and regenerates a new complete "swiped" analysis for my product
function buildSwipeRegenerateMessages(
  screenshot: string,
  originalAnalysis: Record<string, unknown>,
  myBranding: Record<string, unknown>
): { messages: ClaudeMessage[]; system: string } {
  const system = `You are an expert in funnel marketing, quiz design and conversion optimization.
Your task is to regenerate a complete analysis for a new quiz funnel, combining the best practices of the original design with the client's personalized branding.

This is the final phase of the "swipe": you need to produce a complete analysis ready for code generation.

RESPOND ONLY with a valid JSON object, no markdown, no code blocks.`;

  const prompt = `Regenerate a complete "swiped" analysis for my product, combining the competitor's best practices with my branding.

═══ ORIGINAL ANALYSIS (COMPETITOR) ═══
${JSON.stringify(originalAnalysis, null, 2)}

═══ MY BRANDING (generated in the previous phase) ═══
${JSON.stringify(myBranding, null, 2)}

═══ INSTRUCTIONS ═══
Generate a JSON with EXACTLY the same structure as the original analysis but with ALL values adapted to MY brand.
The structure must have these sections:

{
  "brand_identity": {
    "brand_name": "from my branding",
    "logo_description": "description of the ideal logo for my brand",
    "brand_personality": "from my branding",
    "target_audience": "from my branding, more detailed",
    "industry": "from my branding"
  },
  "color_palette": {
    "primary_color": "#hex from my branding",
    "secondary_color": "#hex from my branding",
    "accent_color": "#hex from my branding",
    "background_color": "#hex from my branding",
    "text_color": "#hex from my branding",
    "all_colors": ["complete array of my colors"],
    "color_scheme_type": "color scheme type",
    "color_mood": "mood of my palette"
  },
  "typography": {
    "heading_font_style": "from my branding",
    "body_font_style": "from my branding",
    "font_weight_pattern": "font weight pattern",
    "text_hierarchy": "optimized text hierarchy"
  },
  "layout_structure": {
    "layout_type": "keep effective structure from the original",
    "sections": ["sections adapted to my content"],
    "navigation_style": "navigation style",
    "hero_section": "hero adapted to my message",
    "content_density": "content density",
    "whitespace_usage": "whitespace usage"
  },
  "visual_elements": {
    "images_style": "image style for my brand",
    "icons_style": "from my branding",
    "buttons_style": "button style with my colors",
    "cards_style": "card style with my design",
    "decorative_elements": ["decorative elements"],
    "animations_detected": "recommended animations"
  },
  "cta_analysis": {
    "primary_cta_text": "from my branding/messaging",
    "primary_cta_style": "CTA style with my colors",
    "secondary_ctas": ["secondary CTAs"],
    "cta_placement": "optimal placement"
  },
  "quiz_funnel_elements": {
    "is_quiz_funnel": true,
    "quiz_type": "quiz type for my product",
    "question_style": "question style",
    "answer_format": "answer format",
    "progress_indicator": "progress indicator",
    "steps_detected": "recommended number of steps"
  },
  "overall_assessment": {
    "design_quality_score": 8-10,
    "modernity_score": 8-10,
    "conversion_optimization_score": 8-10,
    "mobile_readiness_estimate": "excellent",
    "key_strengths": ["strengths of my swiped design"],
    "improvement_suggestions": ["suggestions for further improvement"],
    "design_style_tags": ["style tags"]
  },
  "my_branding_summary": {
    "brand_name": "name",
    "value_proposition": "value proposition",
    "key_benefits": ["benefits"],
    "quiz_hook": "quiz hook",
    "quiz_title": "quiz title",
    "quiz_subtitle": "quiz subtitle",
    "cta_primary": "primary CTA",
    "lead_magnet_angle": "lead magnet angle",
    "conversion_strategy": "conversion strategy"
  }
}

CRITICAL:
- COLORS must be from MY branding, NOT the original
- CTAs must use MY brand's MESSAGING
- Layout structure must follow the original's best practices
- The quiz must be relevant to MY product and target
- Scores must be realistic but optimistic (it's a new optimized design)`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      phase,
      screenshot,
      originalAnalysis,
      productInfo,
      myBranding,
    } = body as {
      phase: Phase;
      screenshot: string;
      originalAnalysis: Record<string, unknown>;
      productInfo?: {
        product_name: string;
        product_description: string;
        target_audience: string;
        industry: string;
        tone_of_voice: string;
        unique_selling_points: string;
      };
      myBranding?: Record<string, unknown>;
    };

    if (!phase) {
      return NextResponse.json({ error: 'phase is required' }, { status: 400 });
    }

    const claudeKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
    if (!claudeKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured.' },
        { status: 500 }
      );
    }

    const startTime = Date.now();

    // ─── PHASE 1: MY BRANDING ────────────────────────────
    if (phase === 'my-branding') {
      if (!screenshot || !originalAnalysis || !productInfo) {
        return NextResponse.json(
          { error: 'screenshot, originalAnalysis and productInfo are required for the my-branding phase' },
          { status: 400 }
        );
      }

      const { messages, system } = buildMyBrandingMessages(screenshot, originalAnalysis, productInfo);
      const rawText = await callClaude(messages, claudeKey, 8192, system);
      const brandingData = parseJsonSafe(rawText);

      return NextResponse.json({
        success: !!brandingData,
        phase: 'my-branding',
        myBranding: brandingData,
        myBrandingRaw: !brandingData ? rawText : undefined,
        duration_ms: Date.now() - startTime,
      });
    }

    // ─── PHASE 2: SWIPE REGENERATE ───────────────────────
    if (phase === 'swipe-regenerate') {
      if (!screenshot || !originalAnalysis || !myBranding) {
        return NextResponse.json(
          { error: 'screenshot, originalAnalysis and myBranding are required for the swipe-regenerate phase' },
          { status: 400 }
        );
      }

      const { messages, system } = buildSwipeRegenerateMessages(screenshot, originalAnalysis, myBranding);
      const rawText = await callClaude(messages, claudeKey, 8192, system);
      const swipedAnalysis = parseJsonSafe(rawText);

      return NextResponse.json({
        success: !!swipedAnalysis,
        phase: 'swipe-regenerate',
        swipedAnalysis,
        swipedAnalysisRaw: !swipedAnalysis ? rawText : undefined,
        duration_ms: Date.now() - startTime,
      });
    }

    return NextResponse.json({ error: `Invalid phase: ${phase}` }, { status: 400 });
  } catch (error) {
    console.error('[quiz-creator/swipe-analysis] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Error during swipe',
      },
      { status: 500 }
    );
  }
}
