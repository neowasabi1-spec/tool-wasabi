import { NextRequest, NextResponse } from 'next/server';

// =====================================================
// Design Spec extracted by Gemini Vision from screenshots
// =====================================================

export interface DesignSpec {
  color_palette: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text_primary: string;
    text_secondary: string;
    button_bg: string;
    button_text: string;
    progress_bar: string;
    progress_bar_bg: string;
    card_bg: string;
    border: string;
  };
  gradients: string[];
  typography: {
    heading_style: string;
    body_style: string;
    font_family_detected: string;
  };
  layout: {
    max_width: string;
    alignment: string;
    card_style: string;
    border_radius: string;
    shadow_style: string;
    spacing: string;
  };
  progress_bar: {
    style: string;
    position: string;
    color: string;
    bg_color: string;
  };
  button_style: {
    shape: string;
    size: string;
    has_icon: boolean;
    has_shadow: boolean;
    hover_effect: string;
  };
  options_style: {
    layout: string;
    item_style: string;
    has_icons: boolean;
    has_images: boolean;
    selected_indicator: string;
  };
  visual_elements: {
    has_illustrations: boolean;
    has_product_images: boolean;
    has_testimonials: boolean;
    has_trust_badges: boolean;
    animation_style: string;
  };
  overall_mood: string;
}

const DESIGN_ANALYSIS_PROMPT = `You are a senior UI/UX designer and CSS expert. Analyze this screenshot of a quiz funnel page and extract the EXACT visual design specifications.

Return ONLY a valid JSON object (no markdown, no code blocks) with this EXACT structure:

{
  "color_palette": {
    "primary": "#hex - the dominant brand color used in headings, accents",
    "secondary": "#hex - the secondary brand color",
    "accent": "#hex - highlight/accent color for interactive elements",
    "background": "#hex - main page background",
    "text_primary": "#hex - main text color",
    "text_secondary": "#hex - secondary/muted text color",
    "button_bg": "#hex - primary CTA button background",
    "button_text": "#hex - primary CTA button text color",
    "progress_bar": "#hex - progress bar filled color",
    "progress_bar_bg": "#hex - progress bar track/unfilled color",
    "card_bg": "#hex - card/option background color",
    "border": "#hex - border color for cards/inputs"
  },
  "gradients": ["css gradient strings if any, e.g. 'linear-gradient(135deg, #hex1, #hex2)'"],
  "typography": {
    "heading_style": "weight and approximate size, e.g. 'bold 28px' or 'semibold 24px'",
    "body_style": "weight and approximate size, e.g. 'normal 16px' or 'medium 14px'",
    "font_family_detected": "sans-serif or serif or rounded-sans or monospace"
  },
  "layout": {
    "max_width": "narrow (480px) or medium (640px) or wide (800px)",
    "alignment": "center or left",
    "card_style": "rounded or sharp or pill",
    "border_radius": "none (0) or small (4-6px) or medium (8-12px) or large (16-20px) or pill (9999px)",
    "shadow_style": "none or subtle or medium or strong",
    "spacing": "compact or normal or spacious"
  },
  "progress_bar": {
    "style": "thin-line or thick-bar or steps-dots or segmented or none",
    "position": "top or below-header or inline or bottom or none",
    "color": "#hex",
    "bg_color": "#hex"
  },
  "button_style": {
    "shape": "rounded or pill or sharp",
    "size": "small or medium or large or full-width",
    "has_icon": false,
    "has_shadow": false,
    "hover_effect": "darken or scale or glow or none"
  },
  "options_style": {
    "layout": "vertical-list or grid-2col or grid-3col or horizontal-scroll",
    "item_style": "card or button or pill or radio-list or checkbox-list or image-card",
    "has_icons": false,
    "has_images": false,
    "selected_indicator": "border-highlight or bg-fill or checkmark or scale"
  },
  "visual_elements": {
    "has_illustrations": false,
    "has_product_images": false,
    "has_testimonials": false,
    "has_trust_badges": false,
    "animation_style": "fade or slide-up or scale or none"
  },
  "overall_mood": "clinical or playful or premium or minimal or energetic or warm or scientific"
}

CRITICAL: Provide actual hex color values you observe in the screenshot, not placeholders. Be precise about colors — look at buttons, backgrounds, text, progress bars, and cards carefully.`;

async function analyzeDesignWithGemini(
  screenshotBase64: string,
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
              { text: DESIGN_ANALYSIS_PROMPT },
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
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function parseJsonResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Try extracting from markdown code block
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try {
        return JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
      } catch { /* continue */ }
    }
    // Try finding first { ... } block
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
      } catch { /* give up */ }
    }
    return null;
  }
}

function normalizeDesignSpec(raw: Record<string, unknown>): DesignSpec {
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' && v.trim() ? v.trim() : fallback;
  const bool = (v: unknown, fallback = false): boolean =>
    typeof v === 'boolean' ? v : fallback;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const cp = obj(raw.color_palette);
  const ty = obj(raw.typography);
  const la = obj(raw.layout);
  const pb = obj(raw.progress_bar);
  const bs = obj(raw.button_style);
  const os = obj(raw.options_style);
  const ve = obj(raw.visual_elements);

  return {
    color_palette: {
      primary: str(cp.primary, '#2563EB'),
      secondary: str(cp.secondary, '#1E40AF'),
      accent: str(cp.accent, '#F59E0B'),
      background: str(cp.background, '#FFFFFF'),
      text_primary: str(cp.text_primary, '#1F2937'),
      text_secondary: str(cp.text_secondary, '#6B7280'),
      button_bg: str(cp.button_bg, '#2563EB'),
      button_text: str(cp.button_text, '#FFFFFF'),
      progress_bar: str(cp.progress_bar, '#2563EB'),
      progress_bar_bg: str(cp.progress_bar_bg, '#E5E7EB'),
      card_bg: str(cp.card_bg, '#FFFFFF'),
      border: str(cp.border, '#E5E7EB'),
    },
    gradients: arr(raw.gradients),
    typography: {
      heading_style: str(ty.heading_style, 'bold 24px'),
      body_style: str(ty.body_style, 'normal 16px'),
      font_family_detected: str(ty.font_family_detected, 'sans-serif'),
    },
    layout: {
      max_width: str(la.max_width, 'medium (640px)'),
      alignment: str(la.alignment, 'center'),
      card_style: str(la.card_style, 'rounded'),
      border_radius: str(la.border_radius, 'medium (8-12px)'),
      shadow_style: str(la.shadow_style, 'subtle'),
      spacing: str(la.spacing, 'normal'),
    },
    progress_bar: {
      style: str(pb.style, 'thin-line'),
      position: str(pb.position, 'top'),
      color: str(pb.color, '#2563EB'),
      bg_color: str(pb.bg_color, '#E5E7EB'),
    },
    button_style: {
      shape: str(bs.shape, 'rounded'),
      size: str(bs.size, 'large'),
      has_icon: bool(bs.has_icon),
      has_shadow: bool(bs.has_shadow),
      hover_effect: str(bs.hover_effect, 'darken'),
    },
    options_style: {
      layout: str(os.layout, 'vertical-list'),
      item_style: str(os.item_style, 'card'),
      has_icons: bool(os.has_icons),
      has_images: bool(os.has_images),
      selected_indicator: str(os.selected_indicator, 'border-highlight'),
    },
    visual_elements: {
      has_illustrations: bool(ve.has_illustrations),
      has_product_images: bool(ve.has_product_images),
      has_testimonials: bool(ve.has_testimonials),
      has_trust_badges: bool(ve.has_trust_badges),
      animation_style: str(ve.animation_style, 'fade'),
    },
    overall_mood: str(raw.overall_mood, 'minimal'),
  };
}

/**
 * Merge multiple DesignSpecs (from multiple screenshots) into one.
 * Uses the first screenshot's values as the base and only overrides
 * if a later spec provides a more specific (non-default) value.
 */
function mergeDesignSpecs(specs: DesignSpec[]): DesignSpec {
  if (specs.length === 0) {
    return normalizeDesignSpec({});
  }
  if (specs.length === 1) {
    return specs[0];
  }
  // Use first as base — it's typically the intro/landing with strongest branding
  const base = { ...specs[0] };
  // Merge gradients from all specs (deduplicate)
  const allGradients = new Set<string>();
  for (const spec of specs) {
    for (const g of spec.gradients) {
      allGradients.add(g);
    }
  }
  base.gradients = Array.from(allGradients);
  return base;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { screenshots, entryUrl, funnelName } = body as {
      screenshots?: string[];
      entryUrl?: string;
      funnelName?: string;
    };

    const geminiKey = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();

    if (!geminiKey) {
      return NextResponse.json(
        { success: false, error: 'Missing GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in .env.local' },
        { status: 400 }
      );
    }

    let screenshotsToAnalyze: string[] = [];

    // Option A: raw base64 screenshots provided directly
    if (screenshots && screenshots.length > 0) {
      screenshotsToAnalyze = screenshots;
    }
    // Option B: fetch from funnel_crawl_steps in Supabase
    else if (entryUrl && funnelName) {
      const { fetchFunnelCrawlStepsByFunnel } = await import('@/lib/supabase-operations');
      const rows = await fetchFunnelCrawlStepsByFunnel(entryUrl, funnelName);
      screenshotsToAnalyze = rows
        .filter((r) => r.screenshot_base64)
        .map((r) => r.screenshot_base64!)
        .slice(0, 3); // Analyze at most 3 screenshots for cost/speed

      if (screenshotsToAnalyze.length === 0) {
        return NextResponse.json(
          { success: false, error: 'No screenshots found in funnel_crawl_steps for this funnel' },
          { status: 404 }
        );
      }
    } else {
      return NextResponse.json(
        { success: false, error: 'Provide either "screenshots" (base64 array) or "entryUrl" + "funnelName" to fetch from DB' },
        { status: 400 }
      );
    }

    console.log(`[design-analysis] Analyzing ${screenshotsToAnalyze.length} screenshot(s) with Gemini Vision`);

    // Analyze each screenshot (limit to 3 for cost)
    const specs: DesignSpec[] = [];
    const errors: string[] = [];

    for (let i = 0; i < screenshotsToAnalyze.length; i++) {
      try {
        const rawText = await analyzeDesignWithGemini(screenshotsToAnalyze[i], geminiKey);
        const parsed = parseJsonResponse(rawText);
        if (parsed) {
          specs.push(normalizeDesignSpec(parsed));
        } else {
          errors.push(`Screenshot ${i + 1}: could not parse Gemini response`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Screenshot ${i + 1}: ${msg}`);
      }
    }

    if (specs.length === 0) {
      return NextResponse.json(
        { success: false, error: `Design analysis failed for all screenshots: ${errors.join('; ')}` },
        { status: 500 }
      );
    }

    const mergedSpec = mergeDesignSpecs(specs);

    console.log(`[design-analysis] Extracted design spec from ${specs.length} screenshot(s). Primary: ${mergedSpec.color_palette.primary}, Mood: ${mergedSpec.overall_mood}`);

    return NextResponse.json({
      success: true,
      designSpec: mergedSpec,
      screenshotsAnalyzed: specs.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Design analysis error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Design analysis failed' },
      { status: 500 }
    );
  }
}
