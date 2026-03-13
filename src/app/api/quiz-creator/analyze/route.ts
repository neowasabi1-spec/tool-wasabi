import { NextRequest, NextResponse } from 'next/server';
import { launchBrowser, type Browser } from '@/lib/get-browser';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const BRANDING_VISION_PROMPT = `You are a design, branding and UI/UX expert. Analyze this web page screenshot and return ONLY a valid JSON object (no markdown, no code blocks) with EXACTLY these keys:

{
  "brand_identity": {
    "brand_name": "detected brand name (or null)",
    "logo_description": "logo description if visible (or null)",
    "brand_personality": "brand personality (e.g. professional, youthful, luxurious, friendly)",
    "target_audience": "estimated target audience",
    "industry": "sector/industry"
  },
  "color_palette": {
    "primary_color": "#hex of primary color",
    "secondary_color": "#hex of secondary color",
    "accent_color": "#hex of accent color",
    "background_color": "#hex of main background color",
    "text_color": "#hex of main text color",
    "all_colors": ["array of all hex colors detected on the page"],
    "color_scheme_type": "scheme type (monochromatic, complementary, analogous, triadic, etc.)",
    "color_mood": "mood conveyed by the palette (e.g. energetic, calm, professional, luxurious)"
  },
  "typography": {
    "heading_font_style": "heading font style (serif, sans-serif, display, etc.)",
    "body_font_style": "body text font style",
    "font_weight_pattern": "pattern of typographic weights used",
    "text_hierarchy": "description of typographic hierarchy"
  },
  "layout_structure": {
    "layout_type": "layout type (single column, grid, hero+content, etc.)",
    "sections": ["array of sections identified on the page"],
    "navigation_style": "navigation style",
    "hero_section": "hero section description if present (or null)",
    "content_density": "content density (minimalist, moderate, dense)",
    "whitespace_usage": "whitespace usage (generous, balanced, compressed)"
  },
  "visual_elements": {
    "images_style": "image style (photos, illustrations, icons, mix)",
    "icons_style": "icon style if present",
    "buttons_style": "button style (rounded, square, pill, ghost, etc.)",
    "cards_style": "card style if present (with shadow, border, flat)",
    "decorative_elements": ["detected decorative elements"],
    "animations_detected": "detected animations or dynamic effects"
  },
  "cta_analysis": {
    "primary_cta_text": "primary CTA text",
    "primary_cta_style": "primary CTA style (color, shape, size)",
    "secondary_ctas": ["secondary CTA texts"],
    "cta_placement": "CTA placement on the page"
  },
  "quiz_funnel_elements": {
    "is_quiz_funnel": true/false,
    "quiz_type": "quiz type if detected (personality, scored, branching, etc.) or null",
    "question_style": "question style if detected",
    "answer_format": "answer format (buttons, cards, slider, etc.) or null",
    "progress_indicator": "progress indicator if present",
    "steps_detected": "number of quiz steps/pages detected or null"
  },
  "overall_assessment": {
    "design_quality_score": 1-10,
    "modernity_score": 1-10,
    "conversion_optimization_score": 1-10,
    "mobile_readiness_estimate": "estimated mobile responsiveness (good, medium, poor)",
    "key_strengths": ["design strengths"],
    "improvement_suggestions": ["improvement suggestions"],
    "design_style_tags": ["style tags (e.g. minimal, corporate, playful, bold, elegant)"]
  }
}`;

function parseJsonResponse(text: string): Record<string, unknown> | null {
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

export async function POST(request: NextRequest) {
  let browser: Browser | null = null;

  try {
    const { url, screenshotDelay } = (await request.json()) as {
      url: string;
      screenshotDelay?: number;
    };

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'The "url" field is required' },
        { status: 400 }
      );
    }

    const geminiKey = (
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_GEMINI_API_KEY ??
      ''
    ).trim();

    if (!geminiKey) {
      return NextResponse.json(
        { error: 'GOOGLE_GEMINI_API_KEY not configured. Add the key in .env.local and restart the server.' },
        { status: 500 }
      );
    }

    // Step 1: Screenshot with Playwright
    browser = await launchBrowser();

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // Use domcontentloaded first (fast), then wait for additional rendering.
    // networkidle often times out on modern pages with analytics/websockets.
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    } catch (navErr) {
      // If even domcontentloaded fails, try with just commit
      await page.goto(url, {
        waitUntil: 'commit',
        timeout: 30_000,
      });
    }

    // Wait for visual rendering to settle.
    // If a custom screenshotDelay is provided (in seconds), use that as the total wait time.
    // Otherwise, use the default strategy: 4s + networkidle attempt + 1.5s.
    const customDelayMs = screenshotDelay && screenshotDelay > 0
      ? Math.round(screenshotDelay * 1000)
      : 0;

    if (customDelayMs > 0) {
      await page.waitForTimeout(customDelayMs);
    } else {
      await page.waitForTimeout(4000);

      // Try to wait for network to settle (best-effort, don't fail if it doesn't)
      try {
        await page.waitForLoadState('networkidle', { timeout: 8_000 });
      } catch {
        // Page has continuous network activity - that's fine, we have the DOM
      }

      await page.waitForTimeout(1500);
    }

    // Dismiss cookie banners
    try {
      const dismissSelectors = [
        '[class*="cookie"] button',
        '[class*="consent"] button',
        '[class*="popup"] [class*="close"]',
        '[class*="modal"] [class*="close"]',
        'button[aria-label="Close"]',
        'button[aria-label="Chiudi"]',
        'button[aria-label="Accept"]',
        'button[aria-label="Accetta"]',
      ];
      for (const sel of dismissSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    } catch {
      // Ignore
    }

    const screenshotBuffer = await page.screenshot({
      fullPage: false,
      type: 'png',
      timeout: 60_000,
    });

    const screenshotBase64 = screenshotBuffer.toString('base64');
    const pageTitle = await page.title();

    await browser.close();
    browser = null;

    // Step 2: Gemini Vision Analysis
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
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
                {
                  text: `${BRANDING_VISION_PROMPT}\n\nAnalyzed URL: ${url}\nPage title: ${pageTitle}`,
                },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: 'application/json',
            temperature: 0.3,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      return NextResponse.json(
        {
          error: `Gemini API error: ${geminiResponse.status}`,
          details: errText.slice(0, 500),
          screenshot: screenshotBase64,
          title: pageTitle,
        },
        { status: 502 }
      );
    }

    const geminiData = (await geminiResponse.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const analysis = parseJsonResponse(rawText);

    return NextResponse.json({
      success: true,
      url,
      title: pageTitle,
      screenshot: screenshotBase64,
      analysis: analysis ?? rawText,
      analysisRaw: !analysis ? rawText : undefined,
    });
  } catch (error) {
    console.error('[quiz-creator/analyze] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Error during analysis',
      },
      { status: 500 }
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
