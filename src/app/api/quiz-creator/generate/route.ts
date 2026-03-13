import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

type Phase = 'generate' | 'review';

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
  maxTokens: number = 16384,
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return text;
}

// ─── Phase 1: GENERATE - Pixel-perfect HTML replication ──────────────────────
function buildGenerateMessages(
  screenshot: string,
  analysis: Record<string, unknown>,
  url: string,
  title: string
): { messages: ClaudeMessage[]; system: string } {
  const system = `You are a senior frontend developer specialized in pixel-perfect web page replication.

Your task is to analyze a web page screenshot along with its detailed analysis (colors, typography, layout, visual elements) and generate HTML/CSS/JS code that EXACTLY REPLICATES that page.

PRIMARY OBJECTIVE: The generated HTML code must be VISUALLY IDENTICAL to the screenshot. You must not create something new, you must EXACTLY REPLICATE what you see.

CRITICAL RULES:
- Generate ONLY the complete HTML code (from <!DOCTYPE html> to </html>)
- NO explanatory comments before or after the code
- NO markdown, no \`\`\` blocks
- The code must be 100% standalone functional
- Use inline CSS in the <style> tag and inline JS in the <script> tag
- Mobile responsive
- The file must be completely self-contained
- DO NOT invent new content - replicate ONLY what is visible in the screenshot
- DO NOT add steps, pages or sections that are NOT in the screenshot`;

  const prompt = `REPLICATE EXACTLY this web page in HTML.

Original URL: ${url}
Title: ${title}

DETAILED PAGE ANALYSIS (from Gemini Vision AI):
${JSON.stringify(analysis, null, 2)}

REPLICATION INSTRUCTIONS:

1. CONTENT: Replicate EXACTLY the text, headings, subheadings, labels, buttons and any content visible in the screenshot. Do not invent anything new.

2. COLORS: Use EXACTLY the colors from the analysis:
   - Primary: ${(analysis as { color_palette?: { primary_color?: string } }).color_palette?.primary_color || 'from analysis'}
   - Secondary: ${(analysis as { color_palette?: { secondary_color?: string } }).color_palette?.secondary_color || 'from analysis'}
   - Accent: ${(analysis as { color_palette?: { accent_color?: string } }).color_palette?.accent_color || 'from analysis'}
   - Background: ${(analysis as { color_palette?: { background_color?: string } }).color_palette?.background_color || 'from analysis'}
   - Text: ${(analysis as { color_palette?: { text_color?: string } }).color_palette?.text_color || 'from analysis'}

3. TYPOGRAPHY: Replicate the typographic style described in the analysis (fonts, weights, hierarchy).

4. LAYOUT: Replicate EXACTLY the layout structure:
   - Type: ${(analysis as { layout_structure?: { layout_type?: string } }).layout_structure?.layout_type || 'from analysis'}
   - Density: ${(analysis as { layout_structure?: { content_density?: string } }).layout_structure?.content_density || 'from analysis'}
   - Whitespace: ${(analysis as { layout_structure?: { whitespace_usage?: string } }).layout_structure?.whitespace_usage || 'from analysis'}

5. VISUAL ELEMENTS: Replicate buttons, cards, icons, progress bars, forms - everything exactly as in the screenshot.

6. INTERACTIVITY: If the page has interactive elements (buttons, forms, selectable options), implement them with working vanilla JavaScript.

7. If there are images in the screenshot, use placeholders with the same dimensions and proportions (you can use divs with background-color or SVG placeholders).

TECHNICAL REQUIREMENTS:
- Single self-contained HTML file with inline <style> and <script>
- Fonts from Google Fonts if identified in the analysis
- Mobile responsive
- Dimensions and spacing as faithful as possible to the screenshot

Generate ONLY the complete HTML code that EXACTLY replicates this page. Nothing else.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

// ─── Phase 1 (SWIPE): GENERATE with swiped branding ─────────────────────────
function buildSwipeGenerateMessages(
  screenshot: string,
  swipedAnalysis: Record<string, unknown>,
  originalAnalysis: Record<string, unknown>,
  url: string,
  title: string
): { messages: ClaudeMessage[]; system: string } {
  const system = `You are a senior frontend developer specialized in web page replication with REBRANDING.

Your task is to:
1. Look at the web page screenshot to understand the LAYOUT, STRUCTURE, PAGE TYPE and ELEMENT ARRANGEMENT
2. Use the SWIPED ANALYSIS (with the client's new branding) to apply COLORS, TEXTS, CTAs, TYPOGRAPHY and BRANDING of the NEW brand
3. Generate HTML that has the SAME STRUCTURE/LAYOUT as the screenshot but with the SWIPED BRANDING

OBJECTIVE: Same structure and layout as the screenshot, but with the client's branding (colors, texts, CTAs, fonts from the swiped branding).

CRITICAL RULES:
- Generate ONLY the complete HTML code (from <!DOCTYPE html> to </html>)
- NO explanatory comments before or after the code
- NO markdown, no \`\`\` blocks
- The code must be 100% standalone functional
- Use inline CSS in the <style> tag and inline JS in the <script> tag
- Mobile responsive
- The file must be completely self-contained
- The STRUCTURE must follow the screenshot (layout, sections, arrangement)
- The CONTENT (texts, colors, CTAs, brand name) must come from the swiped analysis
- ALL images must be self-contained PLACEHOLDERS (div with gradient + inline SVG icon + descriptive text). DO NOT use external image URLs.`;

  const swipedColors = swipedAnalysis.color_palette as Record<string, string> | undefined;
  const swipedBrand = swipedAnalysis.brand_identity as Record<string, string> | undefined;
  const swipedCta = swipedAnalysis.cta_analysis as Record<string, unknown> | undefined;
  const swipedTypo = swipedAnalysis.typography as Record<string, string> | undefined;
  const swipedLayout = swipedAnalysis.layout_structure as Record<string, unknown> | undefined;

  const prompt = `GENERATE an HTML page that has the SAME STRUCTURE as the screenshot but with the NEW BRANDING.

Original URL: ${url}
Original title: ${title}

═══════════════════════════════════════
SWIPED ANALYSIS (USE THIS DATA FOR BRANDING):
═══════════════════════════════════════
${JSON.stringify(swipedAnalysis, null, 2)}

═══════════════════════════════════════
INSTRUCTIONS:
═══════════════════════════════════════

1. STRUCTURE/LAYOUT: Look at the screenshot and replicate the SAME structure:
   - Same layout type (${(originalAnalysis.layout_structure as Record<string, string> | undefined)?.layout_type || 'see screenshot'})
   - Same sections in the same position
   - Same element arrangement (progress bar, questions, options, CTAs)
   - Same spacing and whitespace patterns

2. COLORS: Use ONLY the colors from the SWIPED analysis:
   - Primary: ${swipedColors?.primary_color || 'from swiped analysis'}
   - Secondary: ${swipedColors?.secondary_color || 'from swiped analysis'}
   - Accent: ${swipedColors?.accent_color || 'from swiped analysis'}
   - Background: ${swipedColors?.background_color || 'from swiped analysis'}
   - Text: ${swipedColors?.text_color || 'from swiped analysis'}

3. TEXTS AND CTAs: Use the content from the SWIPED analysis:
   - Brand name: ${swipedBrand?.brand_name || 'from swiped analysis'}
   - Primary CTA: ${swipedCta?.primary_cta_text || 'from swiped analysis'}
   - CTA style: ${swipedCta?.primary_cta_style || 'from swiped analysis'}
   - All texts (headings, questions, options, subheadings) from swiped analysis

4. TYPOGRAPHY: Use fonts from the SWIPED analysis:
   - Heading: ${swipedTypo?.heading_font_style || 'from swiped analysis'}
   - Body: ${swipedTypo?.body_font_style || 'from swiped analysis'}

5. VISUAL ELEMENTS: Replicate the style of buttons, cards and elements as described in the swiped analysis.

6. IMAGES → PLACEHOLDERS: DO NOT use the original screenshot images. Since it's a new brand, ALL images must be replaced with elegant placeholders:
   - Use divs with colored background (from swiped brand colors) with an inline SVG icon (e.g. image icon, product, person) and text like "Product Image", "Hero Image", "Team Photo", etc.
   - Maintain the SAME dimensions and proportions as the original images in the screenshot
   - Placeholder style: rounded borders, light gradient background using brand colors, centered icon, text below icon
   - For avatars/profile photos: use circles with brand initials or user icon
   - For hero images: use divs with gradient and descriptive text
   - DO NOT use external URLs (no placeholder.com, no picsum, no unsplash) - everything must be self-contained

7. INTERACTIVITY: If the original page has interactive elements, implement them with working vanilla JavaScript.

TECHNICAL REQUIREMENTS:
- Single self-contained HTML file with inline <style> and <script>
- Fonts from Google Fonts if specified
- Mobile responsive
- Layout faithful to the screenshot, branding from swiped analysis
- ZERO references to external image URLs - everything self-contained with SVG/CSS placeholders

Generate ONLY the complete HTML code. Nothing else.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

// ─── Phase 2 (SWIPE): REVIEW with swiped branding ───────────────────────────
function buildSwipeReviewMessages(
  screenshot: string,
  code: string,
  swipedAnalysis: Record<string, unknown>
): { messages: ClaudeMessage[]; system: string } {
  const swipedColors = swipedAnalysis.color_palette as Record<string, string> | undefined;
  const swipedBrand = swipedAnalysis.brand_identity as Record<string, string> | undefined;

  const system = `You are a senior code reviewer specialized in web page rebranding.

Your task is to verify that the generated HTML code:
1. Has the SAME STRUCTURE/LAYOUT as the original screenshot
2. Uses the COLORS, TEXTS and BRANDING from the swiped analysis (NOT the original ones)
3. Images are self-contained PLACEHOLDERS (NOT external URLs)

RULES:
- If the code is correct, return it EXACTLY as is
- If the colors DO NOT match the swiped analysis, FIX them
- If the texts/CTAs DO NOT match the swiped analysis, FIX them
- If there are <img> tags with external URLs or original images, REPLACE them with self-contained placeholders (div with gradient from swiped brand colors + inline SVG icon + descriptive text). Maintain same dimensions/proportions.
- Verify that the structure follows the screenshot
- Verify that interactive elements work

RESPOND ONLY with the complete HTML code (from <!DOCTYPE html> to </html>), no markdown, no code blocks, no comments.`;

  const prompt = `Verify this HTML code. It must have the screenshot structure but the swiped branding.

SWIPED BRANDING (colors and texts must be THESE):
- Brand: ${swipedBrand?.brand_name || 'N/A'}
- Primary: ${swipedColors?.primary_color || 'N/A'}
- Secondary: ${swipedColors?.secondary_color || 'N/A'}
- Accent: ${swipedColors?.accent_color || 'N/A'}
- Background: ${swipedColors?.background_color || 'N/A'}
- Text: ${swipedColors?.text_color || 'N/A'}

COMPLETE SWIPED ANALYSIS:
${JSON.stringify(swipedAnalysis, null, 2)}

CODE TO VERIFY:
${code}

CHECKLIST:
1. Does the structure/layout match the screenshot?
2. Are the colors from the SWIPED analysis (not the original)?
3. Are the texts/CTAs from the SWIPED analysis?
4. Is the brand name the swiped one?
5. Is the code responsive?
6. Do the interactive elements work?
7. Are there no syntax errors?
8. Are ALL images self-contained placeholders (div with gradient + inline SVG)? If there are <img> tags with external URLs, replace them with elegant placeholders using the swiped brand colors.

Return the corrected complete HTML code.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

// ─── Phase 2: REVIEW & FIX ──────────────────────────────────────────────────
function buildReviewMessages(
  screenshot: string,
  code: string,
  analysis: Record<string, unknown>
): { messages: ClaudeMessage[]; system: string } {
  const system = `You are a senior code reviewer specialized in pixel-perfect web page replication.

Your task is to compare the generated HTML code with the original screenshot and analysis, verifying that it is a FAITHFUL replica of the original page.

RULES:
- If the code faithfully replicates the screenshot, return it EXACTLY as is
- If there are significant visual differences from the screenshot, FIX the code
- Verify that colors, layout, typography, spacing match the screenshot
- Verify that text content is identical to what is visible in the screenshot
- Verify that interactive elements work
- Verify that the code is responsive

RESPOND ONLY with the complete HTML code (from <!DOCTYPE html> to </html>), no markdown, no code blocks, no explanatory comments.`;

  const prompt = `Compare this HTML code with the original screenshot and analysis. Verify that it is a faithful replica.

ORIGINAL PAGE ANALYSIS:
${JSON.stringify(analysis, null, 2)}

REQUIRED COLORS:
- Primary: ${(analysis as { color_palette?: { primary_color?: string } }).color_palette?.primary_color || 'N/A'}
- Secondary: ${(analysis as { color_palette?: { secondary_color?: string } }).color_palette?.secondary_color || 'N/A'}
- Accent: ${(analysis as { color_palette?: { accent_color?: string } }).color_palette?.accent_color || 'N/A'}
- Background: ${(analysis as { color_palette?: { background_color?: string } }).color_palette?.background_color || 'N/A'}
- Text: ${(analysis as { color_palette?: { text_color?: string } }).color_palette?.text_color || 'N/A'}

CODE TO VERIFY:
${code}

VERIFICATION CHECKLIST:
1. Does the layout match the screenshot?
2. Are the colors from the analysis?
3. Is the typography (fonts, sizes, weights) correct?
4. Is the text content identical to the screenshot?
5. Do the visual elements (buttons, cards, icons, forms) match?
6. Are the spacing and padding correct?
7. Is the code responsive?
8. Are there no HTML/CSS/JS syntax errors?
9. Are there no unclosed HTML tags?
10. Do the interactive elements work?

If there are differences, fix the code to make it more faithful to the screenshot.
Return the corrected complete HTML code.`;

  return {
    system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

function extractHtmlCode(text: string): string {
  const trimmed = text.trim();

  const htmlBlock = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (htmlBlock) return htmlBlock[1].trim();

  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<!doctype')) {
    return trimmed;
  }

  const docTypeMatch = trimmed.match(/(<!DOCTYPE[\s\S]*<\/html>)/i);
  if (docTypeMatch) return docTypeMatch[1].trim();

  return trimmed;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      phase,
      screenshot,
      analysis,
      url,
      title,
      generatedCode,
      swipeMode,
      swipedAnalysis,
      originalAnalysis,
    } = body as {
      phase: Phase;
      screenshot: string;
      analysis: Record<string, unknown>;
      url: string;
      title: string;
      generatedCode?: string;
      swipeMode?: boolean;
      swipedAnalysis?: Record<string, unknown>;
      originalAnalysis?: Record<string, unknown>;
    };

    if (!phase) {
      return NextResponse.json({ error: 'phase is required' }, { status: 400 });
    }

    const claudeKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
    if (!claudeKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured. Add the key in .env.local and restart the server.' },
        { status: 500 }
      );
    }

    const startTime = Date.now();

    // ─── PHASE 1: GENERATE ─────────────────────────────
    if (phase === 'generate') {
      if (!screenshot) {
        return NextResponse.json(
          { error: 'screenshot is required for the generate phase' },
          { status: 400 }
        );
      }

      let messages: ClaudeMessage[];
      let system: string;

      if (swipeMode && swipedAnalysis) {
        // SWIPE MODE: layout from screenshot + branding from swiped analysis
        ({ messages, system } = buildSwipeGenerateMessages(
          screenshot,
          swipedAnalysis,
          originalAnalysis || analysis || {},
          url || '',
          title || ''
        ));
      } else {
        // NORMAL MODE: pixel-perfect replication
        if (!analysis) {
          return NextResponse.json(
            { error: 'analysis is required for the generate phase' },
            { status: 400 }
          );
        }
        ({ messages, system } = buildGenerateMessages(screenshot, analysis, url || '', title || ''));
      }

      const rawText = await callClaude(messages, claudeKey, 16384, system);
      const htmlCode = extractHtmlCode(rawText);

      return NextResponse.json({
        success: true,
        phase: 'generate',
        code: htmlCode,
        swipeMode: !!swipeMode,
        duration_ms: Date.now() - startTime,
      });
    }

    // ─── PHASE 2: REVIEW & FIX ──────────────────────────
    if (phase === 'review') {
      if (!generatedCode || !screenshot) {
        return NextResponse.json(
          { error: 'generatedCode and screenshot are required for the review phase' },
          { status: 400 }
        );
      }

      let messages: ClaudeMessage[];
      let system: string;

      if (swipeMode && swipedAnalysis) {
        ({ messages, system } = buildSwipeReviewMessages(screenshot, generatedCode, swipedAnalysis));
      } else {
        if (!analysis) {
          return NextResponse.json(
            { error: 'analysis is required for the review phase' },
            { status: 400 }
          );
        }
        ({ messages, system } = buildReviewMessages(screenshot, generatedCode, analysis));
      }

      const rawText = await callClaude(messages, claudeKey, 16384, system);
      const finalCode = extractHtmlCode(rawText);

      return NextResponse.json({
        success: true,
        phase: 'review',
        code: finalCode,
        swipeMode: !!swipeMode,
        duration_ms: Date.now() - startTime,
      });
    }

    return NextResponse.json({ error: `Invalid phase: ${phase}` }, { status: 400 });
  } catch (error) {
    console.error('[quiz-creator/generate] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Error during generation',
      },
      { status: 500 }
    );
  }
}
