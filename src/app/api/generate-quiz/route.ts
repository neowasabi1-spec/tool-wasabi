import { NextRequest, NextResponse } from 'next/server';
import { getSingletonBrowser, type Browser } from '@/lib/get-browser';
import { supabase } from '@/lib/supabase';
import type { AffiliateSavedFunnel, Json } from '@/types/database';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

// ─── Reuse DesignSpec from design-analysis ───

interface DesignSpec {
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

interface FunnelStep {
  step_index: number;
  url?: string;
  title?: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

// ─── Playwright singleton ───

async function getBrowser(): Promise<Browser> {
  return getSingletonBrowser();
}

// ─── Phase 1: Screenshot with Playwright ───

async function takeScreenshot(url: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 25000 });
    await page.waitForTimeout(3000);
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });
    return buffer.toString('base64');
  } finally {
    await context.close();
  }
}

// ─── Phase 2: Gemini Vision design analysis ───

const DESIGN_ANALYSIS_PROMPT = `You are a senior UI/UX designer. Analyze this screenshot of a quiz/funnel page and extract the EXACT visual design specifications.
Return ONLY a valid JSON object with this structure:
{
  "color_palette": {
    "primary": "#hex", "secondary": "#hex", "accent": "#hex",
    "background": "#hex", "text_primary": "#hex", "text_secondary": "#hex",
    "button_bg": "#hex", "button_text": "#hex",
    "progress_bar": "#hex", "progress_bar_bg": "#hex",
    "card_bg": "#hex", "border": "#hex"
  },
  "gradients": ["css gradient strings if any"],
  "typography": {
    "heading_style": "weight and size, e.g. 'bold 28px'",
    "body_style": "weight and size, e.g. 'normal 16px'",
    "font_family_detected": "sans-serif or serif or rounded-sans"
  },
  "layout": {
    "max_width": "narrow (480px) or medium (640px) or wide (800px)",
    "alignment": "center or left",
    "card_style": "rounded or sharp or pill",
    "border_radius": "none or small (4-6px) or medium (8-12px) or large (16-20px) or pill",
    "shadow_style": "none or subtle or medium or strong",
    "spacing": "compact or normal or spacious"
  },
  "progress_bar": { "style": "thin-line or thick-bar or steps-dots or none", "position": "top or below-header or none", "color": "#hex", "bg_color": "#hex" },
  "button_style": { "shape": "rounded or pill or sharp", "size": "small or medium or large or full-width", "has_icon": false, "has_shadow": false, "hover_effect": "darken or scale or glow or none" },
  "options_style": { "layout": "vertical-list or grid-2col or grid-3col", "item_style": "card or button or pill or radio-list", "has_icons": false, "has_images": false, "selected_indicator": "border-highlight or bg-fill or checkmark" },
  "visual_elements": { "has_illustrations": false, "has_product_images": false, "has_testimonials": false, "has_trust_badges": false, "animation_style": "fade or slide-up or none" },
  "overall_mood": "clinical or playful or premium or minimal or energetic or warm or scientific"
}
Provide actual hex color values from the screenshot, not placeholders.`;

async function analyzeDesignWithGemini(screenshotBase64: string): Promise<DesignSpec> {
  const geminiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!geminiKey) throw new Error('GOOGLE_GEMINI_API_KEY not configured');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: 'image/png', data: screenshotBase64 } },
              { text: DESIGN_ANALYSIS_PROMPT },
            ],
          },
        ],
        generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const m = rawText.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  return normalizeDesignSpec(parsed);
}

function normalizeDesignSpec(raw: Record<string, unknown>): DesignSpec {
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const str = (v: unknown, fb = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : fb);
  const bool = (v: unknown, fb = false): boolean => (typeof v === 'boolean' ? v : fb);
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

// ─── Phase 3: Claude generates the full HTML quiz ───

function buildClaudePrompt(
  funnel: AffiliateSavedFunnel,
  steps: FunnelStep[],
  designSpec: DesignSpec,
  productOverrides?: { name?: string; description?: string; ctaUrl?: string },
): string {
  const brandName = productOverrides?.name ?? funnel.brand_name ?? funnel.funnel_name;
  const funnelDescription = productOverrides?.description ?? funnel.analysis_summary ?? '';
  const ctaUrl = productOverrides?.ctaUrl ?? '#checkout';

  return `You are an expert front-end developer and quiz funnel designer. Generate a COMPLETE, STANDALONE HTML file that implements a fully working quiz funnel.

=== QUIZ STRUCTURE (from analyzed competitor funnel) ===
Funnel Name: ${funnel.funnel_name}
Brand: ${brandName}
Type: ${funnel.funnel_type}
Category: ${funnel.category}
Total Steps: ${steps.length}
Description: ${funnelDescription}
Persuasion Techniques: ${funnel.persuasion_techniques.join(', ')}
Notable Elements: ${funnel.notable_elements.join(', ')}

=== STEPS DATA ===
${JSON.stringify(steps, null, 2)}

=== DESIGN SPEC (extracted from original site via AI vision) ===
${JSON.stringify(designSpec, null, 2)}

=== PRODUCT / BRAND INFO ===
Brand Name: ${brandName}
CTA URL (final offer link): ${ctaUrl}

=== REQUIREMENTS ===
Generate a SINGLE HTML file with embedded CSS and JavaScript. The file must:

1. **HTML Structure**:
   - Each quiz step is a <div class="step" data-step="N"> element
   - Only the active step is visible (display: block), all others hidden
   - Include a progress bar that updates as the user advances
   - Include ALL ${steps.length} steps from the STEPS DATA above
   - After the last quiz step, show a RESULTS page with personalized recommendation
   - After results, show a CTA/OFFER page linking to ${ctaUrl}

2. **For EACH quiz step**, replicate:
   - The exact question/title from the step data
   - ALL answer options listed in the step (render as clickable cards/buttons)
   - The step_type determines the layout (quiz_question = clickable options, info_screen = info + continue button, lead_capture = email form, checkout = offer page)
   - The CTA button text from step data

3. **CSS** (all in a single <style> tag):
   - Use EXACTLY these colors from the design spec: primary=${designSpec.color_palette.primary}, secondary=${designSpec.color_palette.secondary}, accent=${designSpec.color_palette.accent}, background=${designSpec.color_palette.background}, button_bg=${designSpec.color_palette.button_bg}, button_text=${designSpec.color_palette.button_text}, progress_bar=${designSpec.color_palette.progress_bar}
   - Font family: ${designSpec.typography.font_family_detected}
   - Border radius: ${designSpec.layout.border_radius}
   - Max width: ${designSpec.layout.max_width}
   - Card/option style: ${designSpec.options_style.item_style}, layout: ${designSpec.options_style.layout}
   - Button shape: ${designSpec.button_style.shape}, size: ${designSpec.button_style.size}
   - Progress bar: ${designSpec.progress_bar.style} at ${designSpec.progress_bar.position}
   - Overall mood: ${designSpec.overall_mood}
   - Mobile-first responsive design
   - Smooth transitions between steps (opacity + transform)

4. **JavaScript** (all in a single <script> tag):
   - Quiz state management (current step, selected answers stored in an object)
   - Clicking an option selects it (visual highlight) and auto-advances to next step after 300ms
   - "Continue"/"Next" buttons for info_screen and lead_capture steps
   - Progress bar animation synced with current step
   - Back button functionality on each step (except first)
   - Results page shows a personalized summary based on selected answers
   - Final CTA button links to ${ctaUrl}

5. **Results Page**:
   - Show a personalized headline based on the quiz topic
   - Display a summary card with key recommendations
   - Include trust elements (satisfaction guarantee, secure checkout badge)
   - Strong CTA button to ${ctaUrl}

6. **Quality Requirements**:
   - The quiz MUST be fully navigable from first step to results
   - Every step must show and work correctly
   - The design must look polished and professional
   - All text must be readable, all buttons clickable
   - Progress bar must show accurate progress

CRITICAL: Output ONLY the complete HTML file content. Start with <!DOCTYPE html> and end with </html>. Do NOT wrap in code blocks or add any explanation.`;
}

async function generateWithClaude(prompt: string): Promise<string> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: 'Unknown' } }));
    throw new Error(
      `Claude API ${response.status}: ${(err as { error?: { message?: string } }).error?.message ?? 'Unknown error'}`,
    );
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };

  let html = data.content[0]?.text ?? '';

  // Strip markdown code fences if Claude wrapped the output
  html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Ensure it starts with <!DOCTYPE
  const doctypeIndex = html.indexOf('<!DOCTYPE');
  if (doctypeIndex > 0) {
    html = html.substring(doctypeIndex);
  }

  return html;
}

// ─── Main handler ───

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { funnelId, productOverrides } = body as {
      funnelId: string;
      productOverrides?: { name?: string; description?: string; ctaUrl?: string };
    };

    if (!funnelId) {
      return NextResponse.json({ error: 'Missing funnelId' }, { status: 400 });
    }

    // ── Phase 1: Fetch funnel data from affiliate_saved_funnels ──
    console.log(`[generate-quiz] Phase 1: Fetching funnel ${funnelId}`);

    const { data: funnel, error: fetchError } = await supabase
      .from('affiliate_saved_funnels')
      .select('*')
      .eq('id', funnelId)
      .single();

    if (fetchError || !funnel) {
      return NextResponse.json(
        { error: `Funnel not found: ${fetchError?.message ?? 'Unknown'}` },
        { status: 404 },
      );
    }

    const typedFunnel = funnel as AffiliateSavedFunnel;
    const steps: FunnelStep[] = Array.isArray(typedFunnel.steps)
      ? (typedFunnel.steps as unknown as FunnelStep[])
      : [];

    if (steps.length === 0) {
      return NextResponse.json(
        { error: 'Funnel has no structured steps to generate from' },
        { status: 400 },
      );
    }

    console.log(
      `[generate-quiz] Funnel "${typedFunnel.funnel_name}" — ${steps.length} steps, type: ${typedFunnel.funnel_type}`,
    );

    // ── Phase 2: Screenshot the entry URL with Playwright ──
    let screenshotBase64 = '';
    let designSpec: DesignSpec;

    try {
      console.log(`[generate-quiz] Phase 2: Screenshotting ${typedFunnel.entry_url}`);
      screenshotBase64 = await takeScreenshot(typedFunnel.entry_url);
      console.log(`[generate-quiz] Screenshot captured (${(screenshotBase64.length / 1024).toFixed(0)} KB)`);

      // ── Phase 3: Analyze design with Gemini Vision ──
      console.log('[generate-quiz] Phase 3: Analyzing design with Gemini Vision');
      designSpec = await analyzeDesignWithGemini(screenshotBase64);
      console.log(
        `[generate-quiz] Design analyzed — primary: ${designSpec.color_palette.primary}, mood: ${designSpec.overall_mood}`,
      );
    } catch (err) {
      console.warn('[generate-quiz] Screenshot/Vision failed, using defaults:', (err as Error).message);
      designSpec = normalizeDesignSpec({});
    }

    // ── Phase 4: Generate complete HTML with Claude ──
    console.log('[generate-quiz] Phase 4: Generating quiz HTML with Claude');
    const prompt = buildClaudePrompt(typedFunnel, steps, designSpec, productOverrides);
    const generatedHtml = await generateWithClaude(prompt);

    console.log(`[generate-quiz] Quiz generated: ${generatedHtml.length} chars`);

    const quizStepCount = steps.filter(
      (s) => s.step_type === 'quiz_question' || s.step_type === 'info_screen',
    ).length;

    return NextResponse.json({
      success: true,
      html: generatedHtml,
      designSpec,
      stats: {
        totalSteps: steps.length,
        quizQuestions: quizStepCount,
        htmlSize: generatedHtml.length,
        funnelName: typedFunnel.funnel_name,
        brandName: typedFunnel.brand_name,
      },
    });
  } catch (error) {
    console.error('[generate-quiz] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error generating quiz' },
      { status: 500 },
    );
  }
}
