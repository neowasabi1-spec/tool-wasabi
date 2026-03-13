import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { DesignSpec } from '../design-analysis/route';
import type { CssTokens } from '../screenshot/route';
import type { GeneratedBranding } from '@/types';

interface ProductData {
  name: string;
  description: string;
  price: number;
  benefits: string[];
  ctaText: string;
  ctaUrl: string;
  brandName: string;
  imageUrl?: string;
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

// =====================================================
// SYSTEM PROMPTS — Legacy modes (simple + swap)
// =====================================================

const SYSTEM_PROMPT_SIMPLE = `You are an expert frontend developer specialized in creating interactive marketing quizzes.
When the user asks you to create a quiz, generate a SINGLE complete HTML file that contains:
- Semantic HTML
- CSS embedded in a <style> tag (modern design, responsive, fluid animations)
- JavaScript embedded in a <script> tag for quiz logic

IMPORTANT RULES:
1. The quiz must be fully functional and self-contained in a single HTML file
2. Use a modern design with gradients, shadows, transitions and CSS animations
3. The quiz must be responsive (mobile-first)
4. Include a progress bar to show advancement
5. Include a results page at the end with animations
6. Use vivid colors and an engaging layout
7. Do not use external libraries (no CDN, no framework)
8. The code must work immediately when placed in an iframe
9. Generate ONLY the HTML code, no explanations, no markdown, no backticks
10. Start directly with <!DOCTYPE html> and end with </html>
11. Texts should be in English unless specified otherwise`;

const SYSTEM_PROMPT_SWAP = `You are an expert frontend developer and a quiz funnel marketing expert.
Your task is to EXACTLY REPLICATE the structure and design of a reference quiz funnel, 
but SWAP all the content, branding and copy to adapt it to a NEW PRODUCT.

WHAT YOU MUST DO:
1. ANALYZE the original quiz (screenshot + step structure provided)
2. REPLICATE the exact same structure: same number of questions, same answer types, same result logic, same progress bar, same design patterns
3. SWAP everything for the new product: texts, brand colors, headlines, answer options, results, CTAs
4. GENERATE appropriate branding based on the product brief

OUTPUT RULES:
1. Generate a SINGLE complete self-contained HTML file (CSS + JS embedded)
2. The quiz must work immediately in an iframe
3. Modern design, responsive (mobile-first), with gradients, shadows, transitions and animations
4. DO NOT use external libraries (no CDN, no framework)
5. Generate ONLY pure HTML code — no explanations, no markdown, no backticks
6. Start DIRECTLY with <!DOCTYPE html> and end with </html>
7. Texts should be in the same language as the original quiz

STRUCTURE TO REPLICATE FAITHFULLY:
- Same step sequence (intro → questions → result)
- Same question types (single choice, multiple choice, slider, etc.)
- Same number of options per question
- Same result calculation logic (profiles, scoring, recommendation)
- Same persuasion patterns (urgency, social proof, authority)
- Same visual layout (layout, progress bar, animations)

NEW PRODUCT BRANDING:
- Generate a color palette appropriate for the product
- Create persuasive headlines and copy
- Adapt questions to the product context
- Results must recommend the product with appropriate CTA
- Maintain the same quality and professionalism level as the original quiz`;

// =====================================================
// CHUNKED MODE — System prompts for each chunk
// =====================================================

const SYSTEM_PROMPT_CHUNK_CSS = `You are an expert CSS developer specialized in quiz funnel design.
Your task is to generate ONLY the CSS (content of the <style> tag) for a quiz funnel.

RULES:
1. Use CSS custom properties (--var) for all colors, fonts, spacing, border-radius
2. Include: root variables, minimal reset, container layout, progress bar, buttons, option cards, animations, transitions, responsive breakpoints
3. The design must be mobile-first and responsive
4. Include animations for: step transitions (fadeIn/slideUp), button hover, option selection, progress bar
5. DO NOT generate HTML or JavaScript — ONLY pure CSS
6. DO NOT use external libraries
7. Generate ONLY the CSS code, no explanations, no markdown, no backticks, no <style> tag
8. The CSS must use the EXACT VALUES of colors/fonts/spacing provided in the design spec
9. Generate specific classes for EVERY input type provided (multiple_choice, image_select, checkbox, text_input, numeric_input, slider, body_mapping)
10. Include classes for: .quiz-result (results page), .quiz-checkout (offer page), .quiz-info-screen (informational screens), .quiz-lead-capture (email form)`;

const SYSTEM_PROMPT_CHUNK_JS = `You are an expert JavaScript developer specialized in interactive quizzes.
Your task is to generate ONLY the JavaScript (content of the <script> tag) for a quiz funnel engine.

RULES:
1. Implement: state machine for step navigation, answer tracking, progress calculation, result logic, step transition animations
2. The quiz must handle ALL these step types: intro, quiz_question, info_screen, lead_capture, results, checkout
3. For quiz_question: click on option selects and auto-advances after 300ms
4. For info_screen: show info + Continue button
5. For lead_capture: email form with validation, submit button
6. For results: show personalized result based on collected answers
7. For checkout: show offer with CTA link
8. Use the CSS classes defined in the design spec (will be provided)
9. The code must be vanilla JS — NO frameworks, NO external libraries
10. DO NOT generate HTML or CSS — ONLY pure JavaScript
11. DO NOT use document.write
12. Generate ONLY the JavaScript code, no explanations, no markdown, no backticks, no <script> tag
13. The JS must find DOM elements via data-attributes (data-step, data-step-type, data-option)
14. Include CSS class toggle animations for step transitions
15. Include a working back button for every step (except the first)
16. The progress bar must show real progress based on the number of completed steps`;

const SYSTEM_PROMPT_CHUNK_HTML = `You are an expert frontend developer that generates HTML MARKUP for quiz funnels.
The CSS and JavaScript will be automatically inserted by the server. You generate ONLY the body HTML markup.

RULES:
1. Generate ONLY the <body> content — NO <!DOCTYPE>, NO <html>, NO <head>, NO <style>, NO <script>
2. Start directly with the first quiz div (e.g. <div class="quiz-container">)
3. Generate ALL the HTML markup for every quiz step: intro, questions, info screen, lead capture, results, checkout
4. Use data-step="N" and data-step-type="type" on each screen
5. The first step also has the "active" class
6. Use the CSS classes that will be provided
7. DO NOT use external libraries
8. Generate ONLY pure HTML markup, no explanations, no markdown, no backticks
9. EVERY quiz step MUST be present — do not skip any step
10. ALWAYS include: a results page (data-step-type="results") and an offer page (data-step-type="checkout") at the end`;

// =====================================================
// HELPERS
// =====================================================

function buildDesignSpecText(
  designSpec?: DesignSpec | null,
  cssTokens?: CssTokens | null
): string {
  let text = '';

  if (designSpec) {
    const cp = designSpec.color_palette;
    text += `=== DESIGN SPEC (use these EXACT values) ===\n`;
    text += `COLORS:\n`;
    text += `  --color-primary: ${cp.primary}\n`;
    text += `  --color-secondary: ${cp.secondary}\n`;
    text += `  --color-accent: ${cp.accent}\n`;
    text += `  --color-background: ${cp.background}\n`;
    text += `  --color-text: ${cp.text_primary}\n`;
    text += `  --color-text-secondary: ${cp.text_secondary}\n`;
    text += `  --color-button-bg: ${cp.button_bg}\n`;
    text += `  --color-button-text: ${cp.button_text}\n`;
    text += `  --color-progress: ${cp.progress_bar}\n`;
    text += `  --color-progress-bg: ${cp.progress_bar_bg}\n`;
    text += `  --color-card-bg: ${cp.card_bg}\n`;
    text += `  --color-border: ${cp.border}\n`;
    if (designSpec.gradients.length > 0) {
      text += `GRADIENTS: ${designSpec.gradients.join(' | ')}\n`;
    }
    text += `TYPOGRAPHY:\n`;
    text += `  Heading: ${designSpec.typography.heading_style}\n`;
    text += `  Body: ${designSpec.typography.body_style}\n`;
    text += `  Font family: ${designSpec.typography.font_family_detected}\n`;
    text += `LAYOUT:\n`;
    text += `  Max width: ${designSpec.layout.max_width}\n`;
    text += `  Alignment: ${designSpec.layout.alignment}\n`;
    text += `  Card style: ${designSpec.layout.card_style}\n`;
    text += `  Border radius: ${designSpec.layout.border_radius}\n`;
    text += `  Shadow: ${designSpec.layout.shadow_style}\n`;
    text += `  Spacing: ${designSpec.layout.spacing}\n`;
    text += `PROGRESS BAR:\n`;
    text += `  Style: ${designSpec.progress_bar.style}\n`;
    text += `  Position: ${designSpec.progress_bar.position}\n`;
    text += `  Color: ${designSpec.progress_bar.color}, BG: ${designSpec.progress_bar.bg_color}\n`;
    text += `BUTTONS:\n`;
    text += `  Shape: ${designSpec.button_style.shape}\n`;
    text += `  Size: ${designSpec.button_style.size}\n`;
    text += `  Shadow: ${designSpec.button_style.has_shadow ? 'yes' : 'no'}\n`;
    text += `  Icon: ${designSpec.button_style.has_icon ? 'yes' : 'no'}\n`;
    text += `ANSWER OPTIONS:\n`;
    text += `  Layout: ${designSpec.options_style.layout}\n`;
    text += `  Item style: ${designSpec.options_style.item_style}\n`;
    text += `  Icons: ${designSpec.options_style.has_icons ? 'yes' : 'no'}\n`;
    text += `  Images: ${designSpec.options_style.has_images ? 'yes' : 'no'}\n`;
    text += `  Selection: ${designSpec.options_style.selected_indicator}\n`;
    text += `OVERALL MOOD: ${designSpec.overall_mood}\n`;
    text += `ANIMATIONS: ${designSpec.visual_elements.animation_style}\n`;
    text += '\n';
  }

  if (cssTokens) {
    text += `=== CSS TOKENS REALI (estratti dal DOM originale) ===\n`;
    const printTokens = (label: string, tokens: typeof cssTokens.body) => {
      if (!tokens) return;
      text += `${label}:\n`;
      text += `  color: ${tokens.color}, bg: ${tokens.bg}\n`;
      text += `  font: ${tokens.fontFamily} ${tokens.fontSize} ${tokens.fontWeight}\n`;
      text += `  border-radius: ${tokens.borderRadius}\n`;
      if (tokens.boxShadow && tokens.boxShadow !== 'none') {
        text += `  box-shadow: ${tokens.boxShadow}\n`;
      }
    };
    printTokens('Body', cssTokens.body);
    printTokens('Heading', cssTokens.heading);
    printTokens('Button', cssTokens.button);
    printTokens('Card/Option', cssTokens.card);
    printTokens('Progress Bar', cssTokens.progressBar);
    printTokens('Container', cssTokens.container);
    text += '\n';
  }

  return text;
}

function buildBrandingText(branding: GeneratedBranding): string {
  let text = `=== GENERATED BRANDING ===\n`;
  const bi = branding.brandIdentity;
  text += `Brand: ${bi.brandName}\n`;
  text += `Tagline: ${bi.tagline}\n`;
  text += `Voice/Tone: ${bi.voiceTone}\n`;
  text += `Emotional hook: ${bi.emotionalHook}\n`;
  text += `USP: ${bi.uniqueSellingProposition}\n`;
  text += `Brand colors: primary=${bi.colorPalette.primary}, secondary=${bi.colorPalette.secondary}, accent=${bi.colorPalette.accent}, bg=${bi.colorPalette.background}, text=${bi.colorPalette.text}, cta_bg=${bi.colorPalette.ctaBackground}, cta_text=${bi.colorPalette.ctaText}\n`;
  text += `Typography: heading=${bi.typography.headingStyle}, body=${bi.typography.bodyStyle}\n\n`;

  if (branding.quizBranding) {
    const qb = branding.quizBranding;
    text += `QUIZ BRANDING:\n`;
    text += `  Quiz title: ${qb.quizTitle}\n`;
    text += `  Subtitle: ${qb.quizSubtitle}\n`;
    text += `  Intro text: ${qb.quizIntroText}\n`;
    text += `  Progress label: ${qb.progressBarLabel}\n`;
    text += `  Result headline: ${qb.resultPageHeadline}\n`;
    text += `  Result subheadline: ${qb.resultPageSubheadline}\n`;
    text += `  Result body: ${qb.resultPageBodyCopy}\n`;
    text += `  Personalization hook: ${qb.personalizationHook}\n\n`;
  }

  text += `QUIZ STEPS (content for each step):\n`;
  for (const step of branding.funnelSteps) {
    text += `\n--- STEP ${step.stepIndex} [${step.originalPageType}] ---\n`;
    text += `Headline: ${step.headline}\n`;
    if (step.subheadline) text += `Subheadline: ${step.subheadline}\n`;
    if (step.bodyCopy) text += `Body: ${step.bodyCopy}\n`;
    if (step.ctaTexts.length > 0) text += `CTA: ${step.ctaTexts.join(', ')}\n`;
    if (step.quizQuestion) text += `Question: ${step.quizQuestion}\n`;
    if (step.quizOptions && step.quizOptions.length > 0) {
      text += `Options:\n`;
      step.quizOptions.forEach((opt, i) => {
        const sub = step.quizOptionSubtexts?.[i];
        text += `  ${i + 1}. ${opt}${sub ? ` — ${sub}` : ''}\n`;
      });
    }
    if (step.urgencyElements.length > 0) text += `Urgency: ${step.urgencyElements.join(', ')}\n`;
    if (step.socialProof.length > 0) text += `Social proof: ${step.socialProof.join(', ')}\n`;
  }
  text += '\n';

  const ge = branding.globalElements;
  text += `GLOBAL ELEMENTS:\n`;
  if (ge.socialProofStatements.length > 0) text += `Social proof: ${ge.socialProofStatements.join(' | ')}\n`;
  if (ge.urgencyElements.length > 0) text += `Urgency: ${ge.urgencyElements.join(' | ')}\n`;
  if (ge.trustBadges.length > 0) text += `Trust badges: ${ge.trustBadges.join(', ')}\n`;
  if (ge.guaranteeText) text += `Guarantee: ${ge.guaranteeText}\n`;
  text += '\n';

  if (branding.swipeInstructions) {
    text += `SWIPE INSTRUCTIONS: ${branding.swipeInstructions}\n\n`;
  }

  return text;
}

function sseEncode(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

// =====================================================
// CHUNKED GENERATION — 3 focused Claude calls
// =====================================================

async function runChunkedGeneration(
  client: Anthropic,
  designSpec: DesignSpec | null,
  cssTokens: CssTokens | null,
  branding: GeneratedBranding,
  funnelSteps: FunnelStep[] | undefined,
  funnelMeta: Record<string, unknown> | undefined,
  screenshot: string | undefined,
  extraPrompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
) {
  const designText = buildDesignSpecText(designSpec, cssTokens);
  const brandingText = buildBrandingText(branding);
  const totalSteps = branding.funnelSteps.length;

  // Extract unique input types and step-type mapping from funnel steps
  const inputTypes = new Set<string>();
  const stepTypeMapping: Record<number, string> = {};
  if (funnelSteps) {
    for (const s of funnelSteps) {
      if (s.input_type) inputTypes.add(s.input_type);
      stepTypeMapping[s.step_index] = s.step_type || 'other';
    }
  }
  // Also extract from branding steps
  for (const s of branding.funnelSteps) {
    stepTypeMapping[s.stepIndex] = s.originalPageType || 'other';
  }

  // Ensure results and checkout are in the mapping
  const hasResults = Object.values(stepTypeMapping).some(t => t === 'results' || t === 'thank_you');
  const hasCheckout = Object.values(stepTypeMapping).some(t => t === 'checkout');
  if (!hasResults) stepTypeMapping[totalSteps] = 'results';
  if (!hasCheckout) stepTypeMapping[totalSteps + (hasResults ? 0 : 1)] = 'checkout';

  const inputTypesStr = inputTypes.size > 0
    ? Array.from(inputTypes).join(', ')
    : 'multiple_choice, text_input, button';

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // ── CHUNK 1: CSS Design System ──
  controller.enqueue(sseEncode({ phase: 'css', phaseLabel: 'Generating CSS Design System...' }));

  const cssUserPrompt =
    `Generate the complete CSS design system for a quiz funnel with ${totalSteps} steps.\n\n` +
    designText +
    `The CSS MUST use the EXACT hex colors from the design spec above as CSS custom properties.\n\n` +
    `INPUT TYPES PRESENT IN THE QUIZ: ${inputTypesStr}\n` +
    `Generate specific CSS classes for EVERY input type listed above.\n\n` +
    `Include: :root variables, *, body reset, .quiz-container, .quiz-step (hidden by default), .quiz-step.active (visible), ` +
    `.progress-bar, .progress-fill, .quiz-question, .quiz-options, .quiz-option (card stile), .quiz-option.selected, ` +
    `.quiz-btn (CTA button), .quiz-btn-back (back button), .quiz-result, .quiz-intro, .quiz-lead-capture, .quiz-checkout, .quiz-info-screen, ` +
    `animazioni (@keyframes fadeIn, slideUp), transizioni hover, responsive media queries.\n\n` +
    `Output ONLY pure CSS without <style> tag and without explanations.`;

  const cssStream = await client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    temperature: 0.3,
    system: SYSTEM_PROMPT_CHUNK_CSS,
    messages: [{ role: 'user', content: cssUserPrompt }],
  });

  let cssCode = '';
  for await (const event of cssStream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      cssCode += event.delta.text;
      controller.enqueue(sseEncode({ chunk: 'css', text: event.delta.text }));
    }
  }
  const cssFinal = await cssStream.finalMessage();
  totalInputTokens += cssFinal.usage.input_tokens;
  totalOutputTokens += cssFinal.usage.output_tokens;

  cssCode = cssCode.replace(/^```css\s*/i, '').replace(/```\s*$/i, '').trim();
  cssCode = cssCode.replace(/^<style[^>]*>/i, '').replace(/<\/style>\s*$/i, '').trim();

  controller.enqueue(sseEncode({ phase: 'css_done', cssLength: cssCode.length }));

  // ── CHUNK 2: Quiz JS Engine ──
  controller.enqueue(sseEncode({ phase: 'js', phaseLabel: 'Generating Quiz Engine JS...' }));

  let stepsDescription = '';
  for (const step of branding.funnelSteps) {
    const stepType = stepTypeMapping[step.stepIndex] || step.originalPageType || 'other';
    stepsDescription += `Step ${step.stepIndex} [${stepType}]: `;
    if (step.quizQuestion) {
      stepsDescription += `Question: "${step.quizQuestion}"`;
      if (step.quizOptions && step.quizOptions.length > 0) {
        stepsDescription += ` | Options: ${step.quizOptions.map((o, i) => `${i + 1}.${o}`).join(', ')}`;
      }
    } else {
      stepsDescription += `${step.headline}`;
    }
    stepsDescription += '\n';
  }

  const stepMappingStr = JSON.stringify(stepTypeMapping, null, 2);

  const jsUserPrompt =
    `Generate the JavaScript engine for a quiz with ${totalSteps} steps.\n\n` +
    `STEP-TYPE MAPPING (use this to understand WHAT each step does):\n${stepMappingStr}\n\n` +
    `STEP STRUCTURE:\n${stepsDescription}\n` +
    `CSS CLASSES TO USE:\n` +
    `- .quiz-step: each screen (hidden by default)\n` +
    `- .quiz-step.active: visible screen\n` +
    `- .quiz-option: clickable option\n` +
    `- .quiz-option.selected: selected option\n` +
    `- .quiz-btn: CTA/next button\n` +
    `- .quiz-btn-back: back button\n` +
    `- .progress-fill: progress bar (width in %)\n` +
    `- data-step="N": attribute on each screen\n` +
    `- data-step-type="type": attribute with step type\n` +
    `- data-option: attribute on each option\n\n` +
    `LOGIC PER STEP TYPE:\n` +
    `- "intro": show intro, next button\n` +
    `- "quiz_question": click on option → select → auto-advance after 300ms\n` +
    `- "info_screen": show info + Continue button\n` +
    `- "lead_capture": email form with basic validation, submit button\n` +
    `- "results": show personalized result (use collected answers to personalize text)\n` +
    `- "checkout": show offer with external CTA link\n\n` +
    `The JS must:\n` +
    `1. Initialize showing step 0\n` +
    `2. Handle different behavior for each data-step-type\n` +
    `3. Navigate between steps with animation (fadeIn/slideUp)\n` +
    `4. Update the progress bar based on the current step\n` +
    `5. Collect all answers in an object\n` +
    `6. Working back button (except first step)\n` +
    `7. On the results page, personalize text with collected answers\n\n` +
    `Output ONLY pure JavaScript without <script> tag and without explanations.`;

  const jsStream = await client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 12000,
    temperature: 0.3,
    system: SYSTEM_PROMPT_CHUNK_JS,
    messages: [{ role: 'user', content: jsUserPrompt }],
  });

  let jsCode = '';
  for await (const event of jsStream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      jsCode += event.delta.text;
      controller.enqueue(sseEncode({ chunk: 'js', text: event.delta.text }));
    }
  }
  const jsFinal = await jsStream.finalMessage();
  totalInputTokens += jsFinal.usage.input_tokens;
  totalOutputTokens += jsFinal.usage.output_tokens;

  jsCode = jsCode.replace(/^```(?:javascript|js)\s*/i, '').replace(/```\s*$/i, '').trim();
  jsCode = jsCode.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '').trim();

  controller.enqueue(sseEncode({ phase: 'js_done', jsLength: jsCode.length }));

  // ── CHUNK 3: HTML Markup Only (server assembles final file) ──
  controller.enqueue(sseEncode({ phase: 'html', phaseLabel: 'Generating HTML markup...' }));

  const htmlUserContent: Anthropic.Messages.ContentBlockParam[] = [];

  if (screenshot) {
    htmlUserContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshot },
    });
  }

  let htmlTextPrompt =
    `Generate ONLY the body HTML markup for the quiz funnel (CSS and JS will be automatically inserted by the server).\n\n` +
    brandingText +
    designText;

  if (funnelMeta) {
    htmlTextPrompt += `ORIGINAL FUNNEL: ${JSON.stringify(funnelMeta)}\n\n`;
  }

  if (extraPrompt) {
    htmlTextPrompt += `ADDITIONAL INSTRUCTIONS: ${extraPrompt}\n\n`;
  }

  htmlTextPrompt +=
    `STEP-TYPE MAPPING: ${stepMappingStr}\n\n` +
    `Generate ONLY the body HTML markup:\n` +
    `- Progress bar: <div class="progress-bar"><div class="progress-fill"></div></div>\n` +
    `- Quiz container: <div class="quiz-container">...</div>\n` +
    `- Each step: <div class="quiz-step" data-step="N" data-step-type="type">...</div>\n` +
    `- The first step also has the "active" class\n` +
    `- Options: <div class="quiz-option" data-option="value">...</div>\n` +
    `- Next button: <button class="quiz-btn">...</button>\n` +
    `- Back button: <button class="quiz-btn-back">...</button>\n` +
    `- Use the EXACT texts from the branding provided above\n` +
    `- You MUST include ALL steps from the branding — do not skip any\n` +
    `- You MUST include results and checkout steps at the end\n` +
    `- DO NOT generate <!DOCTYPE>, <html>, <head>, <style> or <script> — ONLY body markup\n` +
    `- Output: from the first <div> to the last </div>, nothing else.`;

  htmlUserContent.push({ type: 'text', text: htmlTextPrompt });

  const htmlStream = await client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    temperature: 0.4,
    system: SYSTEM_PROMPT_CHUNK_HTML,
    messages: [{ role: 'user', content: htmlUserContent }],
  });

  let htmlMarkup = '';
  for await (const event of htmlStream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      htmlMarkup += event.delta.text;
      controller.enqueue(sseEncode({ chunk: 'html_markup', text: event.delta.text }));
    }
  }
  const htmlFinal = await htmlStream.finalMessage();
  totalInputTokens += htmlFinal.usage.input_tokens;
  totalOutputTokens += htmlFinal.usage.output_tokens;

  // Clean HTML markup
  htmlMarkup = htmlMarkup.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Remove any accidental full HTML wrapping
  htmlMarkup = htmlMarkup.replace(/^<!DOCTYPE[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '')
    .replace(/<head>[\s\S]*?<\/head>/gi, '').replace(/<\/?body[^>]*>/gi, '').trim();

  // ── SERVER-SIDE ASSEMBLY ──
  controller.enqueue(sseEncode({ phase: 'assembling', phaseLabel: 'Final server-side assembly...' }));

  const title = (funnelMeta as Record<string, unknown>)?.funnel_name || 'Quiz Funnel';
  const finalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${cssCode}
</style>
</head>
<body>
${htmlMarkup}
<script>
${jsCode}
</script>
</body>
</html>`;

  // Send the assembled HTML as the final output
  controller.enqueue(sseEncode({ assembled: true, html: finalHtml, htmlLength: finalHtml.length }));

  return { totalInputTokens, totalOutputTokens };
}

// =====================================================
// MAIN HANDLER
// =====================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      temperature,
      screenshot,
      product,
      funnelSteps,
      funnelMeta,
      // New chunked mode fields
      designSpec,
      cssTokens,
      branding,
      mode,
    } = body as {
      prompt: string;
      temperature?: number;
      screenshot?: string;
      product?: ProductData;
      funnelSteps?: FunnelStep[];
      funnelMeta?: Record<string, unknown>;
      designSpec?: DesignSpec | null;
      cssTokens?: CssTokens | null;
      branding?: GeneratedBranding | null;
      mode?: 'simple' | 'swap' | 'chunked';
    };

    if (!prompt || typeof prompt !== 'string') {
      return new Response(
        JSON.stringify({ error: 'The "prompt" field is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const client = new Anthropic({ apiKey });

    // Determine mode
    const isChunkedMode = mode === 'chunked' && branding;
    const isSwapMode = !isChunkedMode && !!(screenshot || product || funnelSteps?.length);

    // ── CHUNKED MODE: 3 focused Claude calls ──
    if (isChunkedMode && branding) {
      console.log(`[swipe-quiz] Chunked generation: ${branding.funnelSteps.length} steps, designSpec=${!!designSpec}, cssTokens=${!!cssTokens}`);

      const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const usage = await runChunkedGeneration(
              client,
              designSpec ?? null,
              cssTokens ?? null,
              branding,
              funnelSteps,
              funnelMeta,
              screenshot,
              prompt,
              controller,
            );

            controller.enqueue(sseEncode({
              done: true,
              mode: 'chunked',
              usage: {
                input_tokens: usage.totalInputTokens,
                output_tokens: usage.totalOutputTokens,
              },
            }));
            controller.close();
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Error during chunked generation';
            controller.enqueue(sseEncode({ error: errorMsg }));
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // ── LEGACY MODES: simple + swap (unchanged behavior) ──

    const userContent: Anthropic.Messages.ContentBlockParam[] = [];

    if (screenshot) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshot },
      });
    }

    let textPrompt = '';

    if (isSwapMode) {
      textPrompt += `REQUEST: Replicate this quiz funnel swapping the content for my product.\n\n`;

      if (funnelMeta) {
        textPrompt += `=== REFERENCE QUIZ FUNNEL ===\n`;
        const fm = funnelMeta as Record<string, unknown>;
        if (fm.funnel_name) textPrompt += `Name: ${fm.funnel_name}\n`;
        if (fm.brand_name) textPrompt += `Original brand: ${fm.brand_name}\n`;
        if (fm.entry_url) textPrompt += `URL: ${fm.entry_url}\n`;
        if (fm.funnel_type) textPrompt += `Type: ${fm.funnel_type}\n`;
        if (fm.category) textPrompt += `Category: ${fm.category}\n`;
        if (fm.total_steps) textPrompt += `Total steps: ${fm.total_steps}\n`;
        if (fm.lead_capture_method) textPrompt += `Lead capture method: ${fm.lead_capture_method}\n`;
        if (fm.analysis_summary) textPrompt += `Analysis: ${fm.analysis_summary}\n`;
        if (Array.isArray(fm.persuasion_techniques) && fm.persuasion_techniques.length) {
          textPrompt += `Persuasion techniques: ${fm.persuasion_techniques.join(', ')}\n`;
        }
        if (Array.isArray(fm.notable_elements) && fm.notable_elements.length) {
          textPrompt += `Notable elements: ${fm.notable_elements.join(', ')}\n`;
        }
        textPrompt += '\n';
      }

      // Inject design spec into legacy swap mode too (if available)
      if (designSpec || cssTokens) {
        textPrompt += buildDesignSpecText(designSpec, cssTokens);
      }

      if (funnelSteps && funnelSteps.length > 0) {
        textPrompt += `=== COMPLETE STEP STRUCTURE (replicate faithfully) ===\n`;
        for (const step of funnelSteps) {
          textPrompt += `\n--- STEP ${step.step_index} ---\n`;
          if (step.title) textPrompt += `Title: ${step.title}\n`;
          if (step.step_type) textPrompt += `Type: ${step.step_type}\n`;
          if (step.input_type) textPrompt += `Input: ${step.input_type}\n`;
          if (step.description) textPrompt += `Description: ${step.description}\n`;
          if (step.cta_text) textPrompt += `CTA: ${step.cta_text}\n`;
          if (step.url) textPrompt += `URL: ${step.url}\n`;
          if (step.options && step.options.length > 0) {
            textPrompt += `Answer options:\n`;
            step.options.forEach((opt, i) => {
              textPrompt += `  ${i + 1}. ${opt}\n`;
            });
          }
        }
        textPrompt += '\n';
      }

      if (product) {
        textPrompt += `=== MY PRODUCT (use this data for branding) ===\n`;
        textPrompt += `Product name: ${product.name}\n`;
        textPrompt += `Brand: ${product.brandName}\n`;
        textPrompt += `Description: ${product.description}\n`;
        textPrompt += `Price: €${product.price}\n`;
        if (product.benefits.length > 0) {
          textPrompt += `Benefits:\n`;
          product.benefits.forEach((b, i) => {
            textPrompt += `  ${i + 1}. ${b}\n`;
          });
        }
        textPrompt += `Main CTA: ${product.ctaText}\n`;
        textPrompt += `CTA URL: ${product.ctaUrl}\n`;
        textPrompt += '\n';
      }

      if (screenshot) {
        textPrompt += `I have attached a SCREENSHOT of the original quiz. Faithfully replicate the visual design you see:\n`;
        textPrompt += `- Same layout and arrangement\n`;
        textPrompt += `- Same graphic patterns (progress bar, cards, buttons)\n`;
        textPrompt += `- Same animations and transitions\n`;
        textPrompt += `- BUT with MY product's colors, texts and branding\n\n`;
      }

      textPrompt += `ADDITIONAL INSTRUCTIONS: ${prompt}\n\n`;
      textPrompt += `Generate ONLY the complete HTML code for the swapped quiz. No explanations.`;
    } else {
      textPrompt = `Create a complete interactive HTML/CSS/JS quiz for: ${prompt}\n\nGenerate ONLY the complete HTML code. No additional explanations.`;
    }

    userContent.push({ type: 'text', text: textPrompt });

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32000,
      temperature: temperature ?? (isSwapMode ? 0.5 : 0.7),
      system: isSwapMode ? SYSTEM_PROMPT_SWAP : SYSTEM_PROMPT_SIMPLE,
      messages: [{ role: 'user', content: userContent }],
    });

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              controller.enqueue(sseEncode({ text: event.delta.text }));
            }
          }

          const finalMessage = await stream.finalMessage();
          controller.enqueue(sseEncode({
            done: true,
            mode: isSwapMode ? 'swap' : 'simple',
            usage: {
              input_tokens: finalMessage.usage.input_tokens,
              output_tokens: finalMessage.usage.output_tokens,
            },
          }));
          controller.close();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Error during generation';
          controller.enqueue(sseEncode({ error: errorMsg }));
          controller.close();
        }
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
    console.error('Swipe Quiz generate error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
