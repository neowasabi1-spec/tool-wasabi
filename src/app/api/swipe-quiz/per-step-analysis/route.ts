import { NextRequest } from 'next/server';
import { getSingletonBrowser, type Browser } from '@/lib/get-browser';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';
import { supabase } from '@/lib/supabase';
import type { DesignSpec } from '../design-analysis/route';

/**
 * Per-step analysis: screenshots + Gemini Vision for each step URL
 * in an affiliate_saved_funnel. Returns SSE stream with progress.
 *
 * Input: { funnelId: string }
 * Output: SSE stream with per-step progress, then final result
 */

interface StepAnalysis {
  stepIndex: number;
  url: string;
  title: string;
  stepType: string;
  screenshotBase64: string;
  designSpec: DesignSpec | null;
}

// ─── Playwright singleton ───

async function getBrowser(): Promise<Browser> {
  return getSingletonBrowser();
}

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
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(2500);
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });
    return buffer.toString('base64');
  } finally {
    await context.close();
  }
}

// ─── Gemini Vision ───

const DESIGN_ANALYSIS_PROMPT = `You are a senior UI/UX designer. Analyze this screenshot of a quiz/funnel page and extract visual design specifications.
Return ONLY a valid JSON object:
{
  "color_palette": { "primary": "#hex", "secondary": "#hex", "accent": "#hex", "background": "#hex", "text_primary": "#hex", "text_secondary": "#hex", "button_bg": "#hex", "button_text": "#hex", "progress_bar": "#hex", "progress_bar_bg": "#hex", "card_bg": "#hex", "border": "#hex" },
  "gradients": [],
  "typography": { "heading_style": "bold 28px", "body_style": "normal 16px", "font_family_detected": "sans-serif" },
  "layout": { "max_width": "medium (640px)", "alignment": "center", "card_style": "rounded", "border_radius": "medium (8-12px)", "shadow_style": "subtle", "spacing": "normal" },
  "progress_bar": { "style": "thin-line", "position": "top", "color": "#hex", "bg_color": "#hex" },
  "button_style": { "shape": "rounded", "size": "large", "has_icon": false, "has_shadow": false, "hover_effect": "darken" },
  "options_style": { "layout": "vertical-list", "item_style": "card", "has_icons": false, "has_images": false, "selected_indicator": "border-highlight" },
  "visual_elements": { "has_illustrations": false, "has_product_images": false, "has_testimonials": false, "has_trust_badges": false, "animation_style": "fade" },
  "overall_mood": "minimal"
}
Provide actual hex color values from the screenshot, not placeholders.`;

async function analyzeWithGemini(screenshotBase64: string, geminiKey: string): Promise<DesignSpec | null> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/png', data: screenshotBase64 } },
              { text: DESIGN_ANALYSIS_PROMPT },
            ],
          }],
          generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
        }),
      },
    );

    if (!response.ok) return null;

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
  } catch {
    return null;
  }
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
      primary: str(cp.primary, '#2563EB'), secondary: str(cp.secondary, '#1E40AF'),
      accent: str(cp.accent, '#F59E0B'), background: str(cp.background, '#FFFFFF'),
      text_primary: str(cp.text_primary, '#1F2937'), text_secondary: str(cp.text_secondary, '#6B7280'),
      button_bg: str(cp.button_bg, '#2563EB'), button_text: str(cp.button_text, '#FFFFFF'),
      progress_bar: str(cp.progress_bar, '#2563EB'), progress_bar_bg: str(cp.progress_bar_bg, '#E5E7EB'),
      card_bg: str(cp.card_bg, '#FFFFFF'), border: str(cp.border, '#E5E7EB'),
    },
    gradients: arr(raw.gradients),
    typography: {
      heading_style: str(ty.heading_style, 'bold 24px'),
      body_style: str(ty.body_style, 'normal 16px'),
      font_family_detected: str(ty.font_family_detected, 'sans-serif'),
    },
    layout: {
      max_width: str(la.max_width, 'medium (640px)'), alignment: str(la.alignment, 'center'),
      card_style: str(la.card_style, 'rounded'), border_radius: str(la.border_radius, 'medium (8-12px)'),
      shadow_style: str(la.shadow_style, 'subtle'), spacing: str(la.spacing, 'normal'),
    },
    progress_bar: {
      style: str(pb.style, 'thin-line'), position: str(pb.position, 'top'),
      color: str(pb.color, '#2563EB'), bg_color: str(pb.bg_color, '#E5E7EB'),
    },
    button_style: {
      shape: str(bs.shape, 'rounded'), size: str(bs.size, 'large'),
      has_icon: bool(bs.has_icon), has_shadow: bool(bs.has_shadow),
      hover_effect: str(bs.hover_effect, 'darken'),
    },
    options_style: {
      layout: str(os.layout, 'vertical-list'), item_style: str(os.item_style, 'card'),
      has_icons: bool(os.has_icons), has_images: bool(os.has_images),
      selected_indicator: str(os.selected_indicator, 'border-highlight'),
    },
    visual_elements: {
      has_illustrations: bool(ve.has_illustrations), has_product_images: bool(ve.has_product_images),
      has_testimonials: bool(ve.has_testimonials), has_trust_badges: bool(ve.has_trust_badges),
      animation_style: str(ve.animation_style, 'fade'),
    },
    overall_mood: str(raw.overall_mood, 'minimal'),
  };
}

function mergeDesignSpecs(specs: DesignSpec[]): DesignSpec {
  if (specs.length === 0) return normalizeDesignSpec({});
  if (specs.length === 1) return specs[0];
  const base = { ...specs[0] };
  const allGradients = new Set<string>();
  for (const spec of specs) {
    for (const g of spec.gradients) allGradients.add(g);
  }
  base.gradients = Array.from(allGradients);
  return base;
}

function sseEncode(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Main handler ───

export async function POST(request: NextRequest) {
  try {
    const { funnelId } = (await request.json()) as { funnelId: string };

    if (!funnelId) {
      return new Response(JSON.stringify({ error: 'Missing funnelId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const geminiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '').trim();
    if (!geminiKey) {
      return new Response(JSON.stringify({ error: 'GOOGLE_GEMINI_API_KEY not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch funnel from affiliate_saved_funnels
    const { data: funnel, error: fetchError } = await supabase
      .from('affiliate_saved_funnels')
      .select('*')
      .eq('id', funnelId)
      .single();

    if (fetchError || !funnel) {
      return new Response(JSON.stringify({ error: `Funnel not found: ${fetchError?.message}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
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

    const steps: FunnelStep[] = Array.isArray(funnel.steps)
      ? (funnel.steps as unknown as FunnelStep[])
      : [];

    // Deduplicate URLs (some steps share the same URL)
    const uniqueUrlSteps: FunnelStep[] = [];
    const seenUrls = new Set<string>();
    for (const step of steps) {
      if (step.url && !seenUrls.has(step.url)) {
        seenUrls.add(step.url);
        uniqueUrlSteps.push(step);
      }
    }

    // Limit to max 8 unique URLs for cost/speed (analyze first, middle, and last steps)
    const maxAnalysis = 8;
    let stepsToAnalyze: FunnelStep[];
    if (uniqueUrlSteps.length <= maxAnalysis) {
      stepsToAnalyze = uniqueUrlSteps;
    } else {
      // Pick first 3, last 2, and evenly spaced middle ones
      const picked = new Set<number>([0, 1, 2, uniqueUrlSteps.length - 2, uniqueUrlSteps.length - 1]);
      const remaining = maxAnalysis - picked.size;
      const step = Math.floor(uniqueUrlSteps.length / (remaining + 1));
      for (let i = 1; i <= remaining; i++) {
        picked.add(Math.min(i * step, uniqueUrlSteps.length - 1));
      }
      stepsToAnalyze = [...picked].sort((a, b) => a - b).map((i) => uniqueUrlSteps[i]);
    }

    const totalToAnalyze = stepsToAnalyze.length;

    console.log(
      `[per-step-analysis] Funnel "${funnel.funnel_name}": ${steps.length} steps, ${uniqueUrlSteps.length} unique URLs, analyzing ${totalToAnalyze}`,
    );

    // SSE Stream
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const analyses: StepAnalysis[] = [];
        const designSpecs: DesignSpec[] = [];

        controller.enqueue(
          sseEncode({
            phase: 'start',
            totalSteps: steps.length,
            uniqueUrls: uniqueUrlSteps.length,
            analyzing: totalToAnalyze,
            funnelName: funnel.funnel_name,
          }),
        );

        for (let i = 0; i < stepsToAnalyze.length; i++) {
          const step = stepsToAnalyze[i];
          const url = step.url!;

          controller.enqueue(
            sseEncode({
              phase: 'analyzing_step',
              current: i + 1,
              total: totalToAnalyze,
              stepIndex: step.step_index,
              stepTitle: step.title || `Step ${step.step_index}`,
              url,
            }),
          );

          try {
            // Screenshot
            const screenshotBase64 = await takeScreenshot(url);

            // Gemini Vision analysis
            const spec = await analyzeWithGemini(screenshotBase64, geminiKey);
            if (spec) designSpecs.push(spec);

            analyses.push({
              stepIndex: step.step_index,
              url,
              title: step.title || `Step ${step.step_index}`,
              stepType: step.step_type || 'other',
              screenshotBase64,
              designSpec: spec,
            });

            controller.enqueue(
              sseEncode({
                phase: 'step_done',
                current: i + 1,
                total: totalToAnalyze,
                stepIndex: step.step_index,
                hasDesignSpec: !!spec,
              }),
            );
          } catch (err) {
            console.warn(`[per-step-analysis] Failed for step ${step.step_index} (${url}):`, (err as Error).message);
            controller.enqueue(
              sseEncode({
                phase: 'step_error',
                current: i + 1,
                total: totalToAnalyze,
                stepIndex: step.step_index,
                error: (err as Error).message,
              }),
            );
          }
        }

        // Merge all design specs
        const mergedDesignSpec = mergeDesignSpecs(designSpecs);

        // Build per-step screenshots array (base64 strings for branding)
        const screenshots = analyses
          .filter((a) => a.screenshotBase64)
          .map((a) => a.screenshotBase64);

        controller.enqueue(
          sseEncode({
            phase: 'complete',
            designSpec: mergedDesignSpec,
            screenshots: screenshots.slice(0, 3), // max 3 for branding payload size
            analyzedSteps: analyses.length,
            totalDesignSpecs: designSpecs.length,
          }),
        );

        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[per-step-analysis] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
