/**
 * Branding Generator — AI-powered branding generation
 *
 * Takes a product's information + a reference funnel's analysis data,
 * and generates a complete branding package that can be applied to
 * swipe/replicate the funnel structure with new brand identity.
 *
 * The reference funnel is analyzed step-by-step to understand:
 *  - Copy patterns (headlines, subheadlines, body copy)
 *  - Persuasion techniques used at each step
 *  - Flow structure (quiz questions, CTAs, transitions)
 *  - Visual/emotional hooks
 *
 * The generated branding keeps the EXACT SAME funnel structure
 * but replaces all brand-specific content with the new product.
 */

import type {
  BrandingGenerationInput,
  BrandingReferenceFunnelStep,
  GeneratedBranding,
  BrandingStepContent,
} from '@/types';

// =====================================================
// PROMPT BUILDING
// =====================================================

function buildStepAnalysisSummary(step: BrandingReferenceFunnelStep): string {
  const v = step.visionAnalysis;
  if (!v) {
    return `Step ${step.stepIndex}: [${step.pageType}] "${step.title}" (${step.url}) — no vision analysis available`;
  }

  const parts = [
    `Step ${step.stepIndex}: [${v.page_type}] "${step.title}"`,
    v.headline ? `  HEADLINE: "${v.headline}"` : null,
    v.subheadline ? `  SUBHEADLINE: "${v.subheadline}"` : null,
    v.body_copy ? `  BODY COPY: "${v.body_copy.slice(0, 300)}${v.body_copy.length > 300 ? '...' : ''}"` : null,
    v.cta_text.length > 0 ? `  ALL CTAs: ${v.cta_text.map(c => `"${c}"`).join(', ')}` : null,
    v.next_step_ctas.length > 0 ? `  NEXT-STEP CTAs: ${v.next_step_ctas.map(c => `"${c}"`).join(', ')}` : null,
    v.offer_details ? `  OFFER: "${v.offer_details}"` : null,
    v.price_points.length > 0 ? `  PRICES: ${v.price_points.join(', ')}` : null,
    v.urgency_elements.length > 0 ? `  URGENCY: ${v.urgency_elements.join(', ')}` : null,
    v.social_proof.length > 0 ? `  SOCIAL PROOF: ${v.social_proof.join(', ')}` : null,
    v.persuasion_techniques_used.length > 0 ? `  PERSUASION: ${v.persuasion_techniques_used.join(', ')}` : null,
    step.isQuizStep ? `  [QUIZ STEP] ${step.quizStepLabel || ''}` : null,
  ];

  return parts.filter(Boolean).join('\n');
}

function buildBrandingPrompt(input: BrandingGenerationInput): string {
  const { product, referenceFunnel, options } = input;
  const lang = options?.language || 'en';
  const tone = options?.tone || 'professional';
  const audience = options?.targetAudience || 'general consumer audience';
  const niche = options?.niche || 'health & wellness';

  const isQuizFunnel = referenceFunnel.funnelType === 'quiz_funnel' ||
    referenceFunnel.steps.some(s => s.isQuizStep);

  const stepsAnalysis = referenceFunnel.steps
    .map(buildStepAnalysisSummary)
    .join('\n\n');

  const quizInstructions = isQuizFunnel
    ? `
QUIZ FUNNEL SPECIFIC INSTRUCTIONS:
This is a QUIZ FUNNEL. The reference uses quiz questions to engage, segment, and personalize the user journey.
You MUST generate:
- A compelling quiz title and subtitle for the new brand
- Rewritten quiz questions that feel natural for the new product
- Quiz answer options that segment the audience meaningfully
- A results page that creates a personalized connection to the product
- Each quiz step should maintain the SAME emotional progression as the original
- The quiz should feel like a personalized consultation, not a sales pitch

Include "quizBranding" in your output with:
  quizTitle, quizSubtitle, quizIntroText, progressBarLabel,
  resultPageHeadline, resultPageSubheadline, resultPageBodyCopy, personalizationHook

For each quiz step, include quizQuestion, quizOptions, and quizOptionSubtexts.
`
    : '';

  return `You are an ELITE direct-response copywriter and brand strategist specializing in high-converting marketing funnels. You have studied the greatest copywriters: Eugene Schwartz, Gary Halbert, David Ogilvy, Frank Kern, Russell Brunson.

YOUR MISSION:
Generate a COMPLETE, WINNING branding package for a new product by analyzing and "swiping" the proven structure of an existing successful funnel. You must KEEP the exact same funnel structure, flow, and persuasion patterns — but REPLACE all brand-specific content with the new product's branding.

=== NEW PRODUCT INFORMATION ===
Brand Name: ${product.brandName}
Product Name: ${product.name}
Description: ${product.description}
Price: $${product.price}
Benefits: ${product.benefits.map((b, i) => `${i + 1}. ${b}`).join('\n')}
CTA Text: ${product.ctaText}
CTA URL: ${product.ctaUrl}
${product.imageUrl ? `Image URL: ${product.imageUrl}` : ''}

=== REFERENCE FUNNEL ANALYSIS ===
Funnel Name: ${referenceFunnel.funnelName}
Entry URL: ${referenceFunnel.entryUrl}
Funnel Type: ${referenceFunnel.funnelType}
Total Steps: ${referenceFunnel.steps.length}
${referenceFunnel.analysisSummary ? `Analysis Summary: ${referenceFunnel.analysisSummary}` : ''}
${referenceFunnel.persuasionTechniques?.length ? `Persuasion Techniques: ${referenceFunnel.persuasionTechniques.join(', ')}` : ''}
${referenceFunnel.leadCaptureMethod ? `Lead Capture Method: ${referenceFunnel.leadCaptureMethod}` : ''}
${referenceFunnel.notableElements?.length ? `Notable Elements: ${referenceFunnel.notableElements.join(', ')}` : ''}

=== STEP-BY-STEP FUNNEL BREAKDOWN ===
${stepsAnalysis}

=== GENERATION PARAMETERS ===
Tone: ${tone}
Target Audience: ${audience}
Niche: ${niche}
Language: ${lang}
${quizInstructions}

=== YOUR TASK ===
Analyze the reference funnel's copy patterns, persuasion flow, emotional triggers, and conversion mechanisms.
Then generate a COMPLETE branding package for the new product that:

1. MIRRORS the exact same funnel structure (same number of steps, same page types)
2. Uses the SAME persuasion techniques but adapted to the new product
3. Creates headlines and subheadlines that match the EMOTIONAL INTENSITY of the originals
4. Generates CTAs with the same level of urgency and specificity
5. Produces social proof elements relevant to the new product
6. Maintains the same psychological progression through the funnel
7. Adapts all copy to the specified tone and target audience
8. Writes in the specified language: ${lang === 'it' ? 'Italian' : lang === 'en' ? 'English' : lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : lang === 'fr' ? 'French' : lang === 'pt' ? 'Portuguese' : lang}

CRITICAL RULES:
- Every headline must have a STRONG emotional hook or curiosity gap
- CTAs must be action-oriented and specific (not generic "Click Here")
- Social proof must feel authentic and specific (include numbers, percentages, timeframes)
- Urgency elements must create real FOMO without being dishonest
- Body copy must follow the AIDA framework adapted to each step's purpose
- For quiz funnels: questions must feel like a personalized consultation
- The brand voice must be CONSISTENT across all steps
- Price presentation should use anchoring and value framing

IMPORTANT: Generate the "swipeInstructions" field with specific technical instructions 
on HOW to apply this branding when swiping the HTML of the reference funnel. Include:
- What CSS classes/selectors to target for brand colors
- How to replace text content in headlines, CTAs, body copy
- How to handle images/logos
- Any structural notes for quiz steps

Return ONLY a valid JSON object (no markdown, no code blocks) with this EXACT structure:

{
  "brandIdentity": {
    "brandName": "string",
    "tagline": "string",
    "voiceTone": "description of the brand voice",
    "emotionalHook": "the core emotional trigger",
    "uniqueSellingProposition": "one-sentence USP",
    "colorPalette": {
      "primary": "#hex",
      "secondary": "#hex",
      "accent": "#hex",
      "background": "#hex",
      "text": "#hex",
      "ctaBackground": "#hex",
      "ctaText": "#hex"
    },
    "typography": {
      "headingStyle": "suggested font + weight",
      "bodyStyle": "suggested font + weight"
    }
  },
  "funnelSteps": [
    {
      "stepIndex": 0,
      "originalPageType": "string",
      "headline": "string",
      "subheadline": "string",
      "bodyCopy": "string (full copy for this step)",
      "ctaTexts": ["string"],
      "nextStepCtas": ["string"],
      "offerDetails": "string or null",
      "pricePresentation": "string (how to frame the price)",
      "urgencyElements": ["string"],
      "socialProof": ["string"],
      "persuasionTechniques": ["string"],
      "quizQuestion": "string (only for quiz steps)",
      "quizOptions": ["string (only for quiz steps)"],
      "quizOptionSubtexts": ["string (optional subtexts for quiz options)"]
    }
  ],
  "globalElements": {
    "socialProofStatements": ["5+ social proof statements"],
    "urgencyElements": ["3+ urgency messages"],
    "trustBadges": ["list of trust signals to display"],
    "guaranteeText": "money-back guarantee text",
    "disclaimerText": "compliance disclaimer",
    "footerCopyright": "footer text",
    "headerText": "header/nav brand text"
  },
  ${isQuizFunnel ? `"quizBranding": {
    "quizTitle": "string",
    "quizSubtitle": "string",
    "quizIntroText": "string",
    "progressBarLabel": "string",
    "resultPageHeadline": "string",
    "resultPageSubheadline": "string",
    "resultPageBodyCopy": "string",
    "personalizationHook": "string"
  },` : ''}
  "swipeInstructions": "detailed technical instructions for applying this branding to the swiped HTML",
  "metadata": {
    "provider": "will be filled",
    "model": "will be filled",
    "generatedAt": "will be filled",
    "referenceFunnelName": "${referenceFunnel.funnelName}",
    "referenceFunnelType": "${referenceFunnel.funnelType}",
    "productName": "${product.name}",
    "language": "${lang}",
    "tone": "${tone}"
  }
}`;
}

// =====================================================
// AI PROVIDER CALLS
// =====================================================

async function callClaude(prompt: string, apiKey: string): Promise<{ text: string; model: string }> {
  const model = 'claude-sonnet-4-20250514';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return { text, model };
}

async function callGemini(prompt: string, apiKey: string): Promise<{ text: string; model: string }> {
  const model = 'gemini-2.5-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.7,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return { text, model };
}

// =====================================================
// JSON PARSING WITH FALLBACKS
// =====================================================

function parseJsonFromResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Try direct parse
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // continue to fallbacks
  }

  // Try extracting from markdown code block
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  // Try finding the first { ... } block
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    } catch {
      // give up
    }
  }

  return null;
}

// =====================================================
// RESULT NORMALIZATION
// =====================================================

function normalizeStepContent(raw: Record<string, unknown>): BrandingStepContent {
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' && v.trim() ? v.trim() : fallback;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(String) : [];
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  return {
    stepIndex: typeof raw.stepIndex === 'number' ? raw.stepIndex : 0,
    originalPageType: str(raw.originalPageType, 'other'),
    headline: str(raw.headline, 'Headline needed'),
    subheadline: str(raw.subheadline, ''),
    bodyCopy: str(raw.bodyCopy, ''),
    ctaTexts: arr(raw.ctaTexts),
    nextStepCtas: arr(raw.nextStepCtas),
    offerDetails: strOrNull(raw.offerDetails),
    pricePresentation: str(raw.pricePresentation, ''),
    urgencyElements: arr(raw.urgencyElements),
    socialProof: arr(raw.socialProof),
    persuasionTechniques: arr(raw.persuasionTechniques),
    quizQuestion: typeof raw.quizQuestion === 'string' ? raw.quizQuestion : undefined,
    quizOptions: Array.isArray(raw.quizOptions)
      ? raw.quizOptions.filter((x): x is string => typeof x === 'string')
      : undefined,
    quizOptionSubtexts: Array.isArray(raw.quizOptionSubtexts)
      ? raw.quizOptionSubtexts.filter((x): x is string => typeof x === 'string')
      : undefined,
  };
}

function normalizeBrandingOutput(
  raw: Record<string, unknown>,
  provider: string,
  model: string,
  input: BrandingGenerationInput
): GeneratedBranding {
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' && v.trim() ? v.trim() : fallback;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(String) : [];

  const brandIdentityRaw = (raw.brandIdentity as Record<string, unknown>) || {};
  const colorPaletteRaw = (brandIdentityRaw.colorPalette as Record<string, unknown>) || {};
  const typographyRaw = (brandIdentityRaw.typography as Record<string, unknown>) || {};
  const globalRaw = (raw.globalElements as Record<string, unknown>) || {};
  const quizRaw = raw.quizBranding as Record<string, unknown> | undefined;
  const stepsRaw = Array.isArray(raw.funnelSteps) ? raw.funnelSteps : [];

  const funnelSteps: BrandingStepContent[] = stepsRaw.map((s: unknown) => {
    if (typeof s === 'object' && s !== null) {
      return normalizeStepContent(s as Record<string, unknown>);
    }
    return normalizeStepContent({});
  });

  const result: GeneratedBranding = {
    brandIdentity: {
      brandName: str(brandIdentityRaw.brandName, input.product.brandName),
      tagline: str(brandIdentityRaw.tagline),
      voiceTone: str(brandIdentityRaw.voiceTone, input.options?.tone || 'professional'),
      emotionalHook: str(brandIdentityRaw.emotionalHook),
      uniqueSellingProposition: str(brandIdentityRaw.uniqueSellingProposition),
      colorPalette: {
        primary: str(colorPaletteRaw.primary, '#2563EB'),
        secondary: str(colorPaletteRaw.secondary, '#1E40AF'),
        accent: str(colorPaletteRaw.accent, '#F59E0B'),
        background: str(colorPaletteRaw.background, '#FFFFFF'),
        text: str(colorPaletteRaw.text, '#1F2937'),
        ctaBackground: str(colorPaletteRaw.ctaBackground, '#16A34A'),
        ctaText: str(colorPaletteRaw.ctaText, '#FFFFFF'),
      },
      typography: {
        headingStyle: str(typographyRaw.headingStyle, 'Inter Bold'),
        bodyStyle: str(typographyRaw.bodyStyle, 'Inter Regular'),
      },
    },
    funnelSteps,
    globalElements: {
      socialProofStatements: arr(globalRaw.socialProofStatements),
      urgencyElements: arr(globalRaw.urgencyElements),
      trustBadges: arr(globalRaw.trustBadges),
      guaranteeText: str(globalRaw.guaranteeText),
      disclaimerText: str(globalRaw.disclaimerText),
      footerCopyright: str(globalRaw.footerCopyright, `© ${new Date().getFullYear()} ${input.product.brandName}`),
      headerText: str(globalRaw.headerText, input.product.brandName),
    },
    swipeInstructions: str(raw.swipeInstructions),
    metadata: {
      provider,
      model,
      generatedAt: new Date().toISOString(),
      referenceFunnelName: input.referenceFunnel.funnelName,
      referenceFunnelType: input.referenceFunnel.funnelType,
      productName: input.product.name,
      language: input.options?.language || 'en',
      tone: input.options?.tone || 'professional',
    },
  };

  if (quizRaw && typeof quizRaw === 'object') {
    result.quizBranding = {
      quizTitle: str(quizRaw.quizTitle),
      quizSubtitle: str(quizRaw.quizSubtitle),
      quizIntroText: str(quizRaw.quizIntroText),
      progressBarLabel: str(quizRaw.progressBarLabel),
      resultPageHeadline: str(quizRaw.resultPageHeadline),
      resultPageSubheadline: str(quizRaw.resultPageSubheadline),
      resultPageBodyCopy: str(quizRaw.resultPageBodyCopy),
      personalizationHook: str(quizRaw.personalizationHook),
    };
  }

  return result;
}

// =====================================================
// MAIN EXPORT — generateBranding
// =====================================================

export interface GenerateBrandingResult {
  success: boolean;
  branding?: GeneratedBranding;
  error?: string;
  rawResponse?: string;
}

/**
 * Generate complete branding from a product and reference funnel.
 *
 * @param input - Product, reference funnel, and options
 * @returns The generated branding ready to be applied to the swipe
 */
export async function generateBranding(
  input: BrandingGenerationInput
): Promise<GenerateBrandingResult> {
  const provider = input.options?.provider || 'gemini';

  const rawClaude = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  const rawGemini = (
    (process.env.GEMINI_API_KEY ?? '') ||
    (process.env.GOOGLE_GEMINI_API_KEY ?? '')
  ).trim();

  const apiKey = provider === 'claude' ? rawClaude : rawGemini;

  if (!apiKey) {
    return {
      success: false,
      error: provider === 'claude'
        ? 'Missing ANTHROPIC_API_KEY. Add it to .env.local and restart.'
        : 'Missing GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY. Add it to .env.local and restart.',
    };
  }

  if (!input.product?.name || !input.product?.brandName) {
    return {
      success: false,
      error: 'Product name and brandName are required.',
    };
  }

  if (!input.referenceFunnel?.steps?.length) {
    return {
      success: false,
      error: 'Reference funnel must have at least one step.',
    };
  }

  const prompt = buildBrandingPrompt(input);

  console.log(`[branding-generator] Generating branding with ${provider} for "${input.product.name}" from funnel "${input.referenceFunnel.funnelName}" (${input.referenceFunnel.steps.length} steps)`);

  try {
    const { text, model } = provider === 'claude'
      ? await callClaude(prompt, apiKey)
      : await callGemini(prompt, apiKey);

    console.log(`[branding-generator] Got response from ${provider} (${text.length} chars)`);

    const parsed = parseJsonFromResponse(text);
    if (!parsed) {
      console.error('[branding-generator] Failed to parse JSON:', text.slice(0, 500));
      return {
        success: false,
        error: 'Could not parse JSON response from AI model.',
        rawResponse: text.slice(0, 2000),
      };
    }

    const branding = normalizeBrandingOutput(parsed, provider, model, input);

    console.log(`[branding-generator] Generated branding: ${branding.funnelSteps.length} steps, brand="${branding.brandIdentity.brandName}"`);

    return { success: true, branding };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[branding-generator] Error:', msg);
    return {
      success: false,
      error: msg,
    };
  }
}

/**
 * Helper: builds the input for generateBranding from DB data.
 * Converts FunnelCrawlStepRow into BrandingReferenceFunnelStep.
 */
export function buildBrandingInputFromDb(
  product: {
    name: string;
    description: string;
    price: number;
    benefits: string[];
    cta_text: string;
    cta_url: string;
    brand_name: string;
    image_url?: string | null;
  },
  funnelSteps: Array<{
    step_index: number;
    url: string;
    title: string;
    step_data: unknown;
    vision_analysis: unknown;
    funnel_name: string;
    entry_url: string;
    funnel_tag?: string | null;
  }>,
  options?: {
    provider?: 'claude' | 'gemini';
    tone?: 'professional' | 'casual' | 'urgent' | 'friendly' | 'luxury' | 'scientific' | 'empathetic';
    targetAudience?: string;
    niche?: string;
    language?: string;
    funnelType?: string;
    analysisSummary?: string;
    persuasionTechniques?: string[];
    leadCaptureMethod?: string;
    notableElements?: string[];
  }
): BrandingGenerationInput {
  const first = funnelSteps[0];

  const isQuiz = funnelSteps.some(s => {
    const sd = s.step_data as Record<string, unknown> | null;
    return sd?.isQuizStep === true;
  });

  const steps = funnelSteps.map((s) => {
    const sd = s.step_data as Record<string, unknown> | null;
    const va = s.vision_analysis as Record<string, unknown> | null;

    const step: BrandingReferenceFunnelStep = {
      stepIndex: s.step_index,
      url: s.url,
      title: s.title,
      pageType: (va?.page_type as string) || 'other',
      isQuizStep: sd?.isQuizStep === true,
      quizStepLabel: typeof sd?.quizStepLabel === 'string' ? sd.quizStepLabel : undefined,
    };

    if (va) {
      const arrField = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      const strField = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() ? v.trim() : null;

      step.visionAnalysis = {
        page_type: (va.page_type as string) || 'other',
        headline: strField(va.headline),
        subheadline: strField(va.subheadline),
        body_copy: strField(va.body_copy),
        cta_text: arrField(va.cta_text),
        next_step_ctas: arrField(va.next_step_ctas),
        offer_details: strField(va.offer_details),
        price_points: arrField(va.price_points),
        urgency_elements: arrField(va.urgency_elements),
        social_proof: arrField(va.social_proof),
        persuasion_techniques_used: arrField(va.persuasion_techniques_used),
      };
    }

    return step;
  });

  return {
    product: {
      name: product.name,
      description: product.description,
      price: product.price,
      benefits: product.benefits || [],
      ctaText: product.cta_text,
      ctaUrl: product.cta_url,
      brandName: product.brand_name,
      imageUrl: product.image_url || undefined,
    },
    referenceFunnel: {
      funnelName: first?.funnel_name || 'Unknown',
      entryUrl: first?.entry_url || '',
      funnelType: options?.funnelType || (isQuiz ? 'quiz_funnel' : 'standard'),
      steps,
      analysisSummary: options?.analysisSummary,
      persuasionTechniques: options?.persuasionTechniques,
      leadCaptureMethod: options?.leadCaptureMethod,
      notableElements: options?.notableElements,
    },
    options: {
      provider: options?.provider || 'gemini',
      tone: options?.tone || 'professional',
      targetAudience: options?.targetAudience,
      niche: options?.niche,
      language: options?.language || 'en',
    },
  };
}
