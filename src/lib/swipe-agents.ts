import {
  PRODUCT_ANALYZER_PROMPT,
  LANDING_ANALYZER_PROMPT,
  CRO_ARCHITECT_PROMPT,
  HTML_BUILDER_PROMPT,
} from './swipe-prompts';
import { getSingletonBrowser } from './get-browser';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SwipeInput {
  url: string;
  productName: string;
  productDescription: string;
  target?: string;
  priceInfo?: string;
  customInstructions?: string;
  language?: string;
}

export interface ProductAnalysis {
  product_category: string;
  product_subcategory: string;
  unique_mechanism: {
    name: string;
    explanation: string;
    scientific_angle: string;
  };
  big_promise: string;
  target_avatar: {
    demographics: string;
    psychographics: string;
    pain_points: string[];
    desires: string[];
    current_solutions: string;
    awareness_level: string;
    sophistication_level: number;
  };
  benefits: Array<{
    benefit: string;
    emotional_hook: string;
    proof_type: string;
  }>;
  objections: Array<{
    objection: string;
    reframe: string;
    proof_needed: string;
  }>;
  emotional_triggers: string[];
  copywriting_angles: Array<{
    angle_name: string;
    hook: string;
    framework: string;
  }>;
  price_positioning: {
    strategy: string;
    anchor_price: string;
    value_stack: string[];
    price_justification: string;
  };
  brand_voice: {
    tone: string;
    language_level: string;
    power_words: string[];
  };
}

export interface LandingSection {
  section_index: number;
  section_type: string;
  headline: string;
  subheadline: string;
  body_summary: string;
  cta_text: string;
  cro_patterns: string[];
  effectiveness_score: number;
  position: string;
  estimated_height_vh: number;
  visual_elements: string[];
  html_tag_structure: string;
}

export interface LandingAnalysis {
  page_type: string;
  estimated_word_count: number;
  scroll_depth_sections: number;
  sections: LandingSection[];
  design_system: {
    primary_color: string;
    secondary_color: string;
    accent_color: string;
    background_color: string;
    text_color: string;
    cta_color: string;
    font_style: string;
    heading_style: string;
    spacing_density: string;
    visual_style: string;
    border_radius: string;
    shadow_usage: string;
    image_style: string;
  };
  conversion_elements: {
    total_ctas: number;
    cta_positions: string[];
    cta_styles: string;
    social_proof_types: string[];
    urgency_elements: string[];
    trust_signals: string[];
    lead_capture: string;
  };
  ux_analysis: {
    mobile_readiness: string;
    reading_flow: string;
    attention_hierarchy: string;
    friction_points: string[];
    strengths: string[];
    weaknesses: string[];
  };
  content_strategy: {
    narrative_arc: string;
    emotional_journey: string[];
    proof_density: string;
    copy_style: string;
  };
}

export interface CROSection {
  section_index: number;
  section_type: string;
  source_action: string;
  rationale: string;
  content: {
    headline: string;
    subheadline?: string;
    body_copy: string;
    cta_text?: string;
    cta_secondary?: string;
    list_items?: string[];
    social_proof_items?: Array<{ quote: string; author: string; title: string }>;
    faq_items?: Array<{ question: string; answer: string }>;
    stats?: Array<{ number: string; label: string }>;
    image_description?: string;
    badge_text?: string;
  };
  cro_elements: string[];
  mobile_notes: string;
}

export interface CROPlan {
  strategy_summary: string;
  target_awareness_approach: string;
  primary_framework: string;
  estimated_conversion_lift: string;
  sections: CROSection[];
  above_fold_strategy: {
    primary_hook: string;
    value_proposition: string;
    visual_anchor: string;
    micro_commitment: string;
  };
  design_directives: {
    inherit_from_source: string[];
    modify: Record<string, string>;
    overall_feel: string;
  };
  copy_tone: {
    voice: string;
    language: string;
    formality: string;
    key_phrases_to_repeat: string[];
  };
}

export interface SwipeResult {
  html: string;
  productAnalysis: ProductAnalysis;
  landingAnalysis: LandingAnalysis;
  croPlan: CROPlan;
}

export type ProgressCallback = (phase: string, message: string, progress: number) => void;

// ── Helper: parse JSON from LLM response ─────────────────────────────────────

function extractJSON(text: string): string {
  let cleaned = text.trim();
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) cleaned = codeBlock[1].trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  return cleaned;
}

function parseJSON<T>(text: string): T {
  const cleaned = extractJSON(text);
  return JSON.parse(cleaned) as T;
}

// ── Helper: call Claude API ──────────────────────────────────────────────────

async function callClaude(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
      max_tokens: options?.maxTokens ?? 8192,
      temperature: options?.temperature ?? 0.4,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const errMsg = typeof (err as Record<string, unknown>)?.error === 'object'
      ? JSON.stringify((err as Record<string, unknown>).error)
      : String((err as Record<string, unknown>)?.error ?? 'unknown');
    throw new Error(`Claude API error ${response.status}: ${errMsg}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text ?? '';
}

// ── Helper: call Gemini Vision API ───────────────────────────────────────────

async function callGeminiVision(
  systemPrompt: string,
  textContent: string,
  imageBase64: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: `${systemPrompt}\n\n${textContent}` },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── Helper: capture full-page screenshot + clean HTML ────────────────────────

async function captureLanding(url: string): Promise<{
  screenshot: string;
  html: string;
  title: string;
}> {
  const browser = await getSingletonBrowser();
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

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      const step = window.innerHeight;
      const max = document.body.scrollHeight;
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);

    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 70,
    });
    const screenshotBase64 = screenshot.toString('base64');

    const html = await page.evaluate((pageUrl: string) => {
      function abs(relative: string): string {
        if (
          !relative ||
          relative.startsWith('data:') ||
          relative.startsWith('blob:') ||
          relative.startsWith('#') ||
          relative.startsWith('mailto:') ||
          relative.startsWith('tel:') ||
          relative.startsWith('javascript:')
        )
          return relative;
        if (relative.startsWith('http://') || relative.startsWith('https://'))
          return relative;
        try {
          return new URL(relative, pageUrl).href;
        } catch {
          return relative;
        }
      }

      const allCss: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          let cssText = rules.map((r) => r.cssText).join('\n');
          cssText = cssText.replace(
            /url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi,
            (_m: string, u: string) => {
              const baseUrl = sheet.href || pageUrl;
              try {
                return `url("${new URL(u.trim(), baseUrl).href}")`;
              } catch {
                return `url("${u}")`;
              }
            }
          );
          if (cssText.trim()) allCss.push(cssText);
        } catch {
          /* CORS */
        }
      }

      const docClone = document.documentElement.cloneNode(true) as HTMLElement;
      docClone.querySelectorAll('script').forEach((s) => s.remove());
      docClone.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
        });
      });
      docClone.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());

      docClone
        .querySelectorAll(
          '[src],[href],[poster],[data-src],[data-lazy-src],[data-original],[data-bg],[action]'
        )
        .forEach((el) => {
          [
            'src',
            'href',
            'poster',
            'data-src',
            'data-lazy-src',
            'data-original',
            'data-bg',
            'action',
          ].forEach((attr) => {
            const val = el.getAttribute(attr);
            if (
              val &&
              !val.startsWith('data:') &&
              !val.startsWith('blob:') &&
              !val.startsWith('#') &&
              !val.startsWith('mailto:')
            ) {
              el.setAttribute(attr, abs(val));
            }
          });
          const srcset = el.getAttribute('srcset');
          if (srcset) {
            el.setAttribute(
              'srcset',
              srcset
                .split(',')
                .map((e: string) => {
                  const p = e.trim().split(/\s+/);
                  if (p[0]) p[0] = abs(p[0]);
                  return p.join(' ');
                })
                .join(', ')
            );
          }
        });

      docClone.querySelectorAll('[style]').forEach((el) => {
        const s = el.getAttribute('style') || '';
        if (s.includes('url(')) {
          el.setAttribute(
            'style',
            s.replace(
              /url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi,
              (_m: string, u: string) => `url("${abs(u.trim())}")`
            )
          );
        }
      });

      const head = docClone.querySelector('head');
      if (head && allCss.length > 0) {
        head.querySelectorAll('style').forEach((s) => s.remove());
        const styleEl = document.createElement('style');
        styleEl.textContent = allCss.join('\n\n');
        const after =
          head.querySelector('meta[charset]')?.nextSibling || head.firstChild;
        if (after) head.insertBefore(styleEl, after);
        else head.appendChild(styleEl);
      }

      return '<!DOCTYPE html>\n' + docClone.outerHTML;
    }, url);

    const title = await page.title();

    return { screenshot: screenshotBase64, html, title };
  } finally {
    await context.close();
  }
}

// Truncate HTML to fit within token limits while preserving structure
function truncateHTML(html: string, maxChars: number = 60000): string {
  if (html.length <= maxChars) return html;

  const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
  const headContent = headMatch ? headMatch[0] : '';
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[0] : html;

  const remaining = maxChars - headContent.length - 500;
  const truncatedBody = bodyContent.substring(0, remaining) + '\n<!-- ... truncated ... -->\n</body>';

  return `<!DOCTYPE html>\n<html>\n${headContent}\n${truncatedBody}\n</html>`;
}

// Extract only CSS and design-relevant snippets from HTML (much smaller than full HTML)
function extractDesignReference(html: string): string {
  const parts: string[] = [];

  // Extract <style> content (the actual CSS)
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  let totalCss = '';
  for (const block of styleBlocks) {
    const inner = block.replace(/<\/?style[^>]*>/gi, '');
    totalCss += inner + '\n';
  }
  if (totalCss.length > 15000) totalCss = totalCss.substring(0, 15000) + '\n/* ... truncated ... */';
  if (totalCss.trim()) parts.push(`<style>\n${totalCss}\n</style>`);

  // Extract first few sections of body structure (just tags, not full content)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const body = bodyMatch[1];
    // Get first ~5000 chars of body to capture above-fold structure
    const preview = body.substring(0, 5000);
    parts.push(`<!-- BODY STRUCTURE PREVIEW (first 5000 chars) -->\n${preview}\n<!-- ... rest truncated ... -->`);
  }

  return parts.join('\n\n');
}

// ── Agent 1: Product Analyzer ────────────────────────────────────────────────

export async function analyzeProduct(
  input: SwipeInput,
  onProgress?: ProgressCallback
): Promise<ProductAnalysis> {
  onProgress?.('product_analysis', 'Analyzing product positioning and market strategy...', 10);

  const userMessage = `Analyze this product and create a complete marketing intelligence profile:

Product Name: ${input.productName}
Product Description: ${input.productDescription}
${input.priceInfo ? `Price Info: ${input.priceInfo}` : ''}
${input.target ? `Target Audience: ${input.target}` : ''}
${input.customInstructions ? `Additional Instructions: ${input.customInstructions}` : ''}
${input.language ? `Output Language: ${input.language}` : ''}`;

  const response = await callClaude(PRODUCT_ANALYZER_PROMPT, userMessage, {
    maxTokens: 4096,
    temperature: 0.4,
  });

  onProgress?.('product_analysis', 'Product analysis complete', 25);
  return parseJSON<ProductAnalysis>(response);
}

// ── Agent 2: Landing Page Analyzer ───────────────────────────────────────────

export async function analyzeLanding(
  url: string,
  onProgress?: ProgressCallback
): Promise<{ analysis: LandingAnalysis; originalHtml: string; screenshot: string }> {
  onProgress?.('landing_analysis', 'Capturing landing page with headless browser...', 10);

  const { screenshot, html, title } = await captureLanding(url);

  onProgress?.('landing_analysis', 'Analyzing page structure and CRO patterns with AI Vision...', 20);

  const textSummary = `Landing Page URL: ${url}
Page Title: ${title}
HTML Size: ${html.length} characters

Below is the HTML content (may be truncated). Use it together with the screenshot for analysis.

${truncateHTML(html, 30000)}`;

  const response = await callGeminiVision(
    LANDING_ANALYZER_PROMPT,
    textSummary,
    screenshot
  );

  onProgress?.('landing_analysis', 'Landing analysis complete', 25);

  const analysis = parseJSON<LandingAnalysis>(response);
  return { analysis, originalHtml: html, screenshot };
}

// ── Agent 3: CRO Architect ───────────────────────────────────────────────────

export async function planCROStructure(
  productAnalysis: ProductAnalysis,
  landingAnalysis: LandingAnalysis,
  input: SwipeInput,
  onProgress?: ProgressCallback
): Promise<CROPlan> {
  onProgress?.('cro_planning', 'Designing CRO-optimized page structure...', 50);

  const userMessage = `Create an optimized CRO blueprint for a new landing page.

## PRODUCT INTELLIGENCE (from Product Analyzer):
${JSON.stringify(productAnalysis, null, 2)}

## SOURCE LANDING PAGE ANALYSIS (from Landing Analyzer):
${JSON.stringify(landingAnalysis, null, 2)}

## PRODUCT DETAILS:
- Name: ${input.productName}
- Description: ${input.productDescription}
${input.priceInfo ? `- Price: ${input.priceInfo}` : ''}
${input.target ? `- Target: ${input.target}` : ''}
${input.customInstructions ? `- Custom Instructions: ${input.customInstructions}` : ''}

Create the optimal section-by-section blueprint that:
1. INHERITS the visual design system from the source landing
2. RESTRUCTURES sections for maximum conversion for THIS product
3. WRITES complete copy for every section (not placeholder text)
4. Addresses the target's awareness level: ${productAnalysis.target_avatar.awareness_level}
5. Handles the top objections identified in the product analysis`;

  const response = await callClaude(CRO_ARCHITECT_PROMPT, userMessage, {
    maxTokens: 12000,
    temperature: 0.5,
  });

  onProgress?.('cro_planning', 'CRO strategy complete', 70);
  return parseJSON<CROPlan>(response);
}

// ── Agent 4: HTML Builder ────────────────────────────────────────────────────

export async function buildHTML(
  croPlan: CROPlan,
  landingAnalysis: LandingAnalysis,
  originalHtml: string,
  onProgress?: ProgressCallback
): Promise<string> {
  onProgress?.('html_generation', 'Building production-ready HTML landing page...', 75);

  // Compact the CRO plan: keep structure but trim excessively long body_copy
  const compactSections = croPlan.sections.map((s) => ({
    ...s,
    content: {
      ...s.content,
      body_copy: s.content.body_copy?.length > 800
        ? s.content.body_copy.substring(0, 800) + '...'
        : s.content.body_copy,
    },
  }));

  const compactPlan = {
    strategy_summary: croPlan.strategy_summary,
    primary_framework: croPlan.primary_framework,
    sections: compactSections,
    above_fold_strategy: croPlan.above_fold_strategy,
    design_directives: croPlan.design_directives,
    copy_tone: croPlan.copy_tone,
  };

  const ds = landingAnalysis.design_system;

  const userMessage = `Build a complete, production-ready HTML landing page.

## CRO BLUEPRINT (follow this EXACTLY for structure and content):
${JSON.stringify(compactPlan, null, 2)}

## DESIGN SYSTEM:
Colors: primary ${ds.primary_color}, secondary ${ds.secondary_color}, accent ${ds.accent_color}, bg ${ds.background_color}, text ${ds.text_color}, CTA ${ds.cta_color}
Style: ${ds.visual_style}, ${ds.font_style} fonts, ${ds.heading_style} headings, ${ds.spacing_density} spacing
Corners: ${ds.border_radius}, shadows: ${ds.shadow_usage}, images: ${ds.image_style}

Build the complete HTML page. Requirements:
- Use Tailwind CSS via CDN
- Implement EVERY section from the blueprint with all copy
- Mark sections with <!-- SECTION: type --> comments
- Language: ${croPlan.copy_tone?.language || 'en'}
- Responsive, mobile-first, professional
- Use placeholder images with colored backgrounds and descriptive alt text`;

  const response = await callClaude(HTML_BUILDER_PROMPT, userMessage, {
    maxTokens: 16000,
    temperature: 0.6,
  });

  onProgress?.('html_generation', 'HTML generation complete', 95);

  let html = response.trim();
  const codeBlock = html.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (codeBlock) html = codeBlock[1].trim();

  if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
    html = `<!DOCTYPE html>
<html lang="${croPlan.copy_tone.language || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"><\/script>
  <title>${croPlan.sections[0]?.content?.headline || 'Landing Page'}</title>
</head>
<body>
${html}
</body>
</html>`;
  }

  return html;
}

// ── Full Pipeline Orchestrator ───────────────────────────────────────────────

export async function runAgenticSwipe(
  input: SwipeInput,
  onProgress?: ProgressCallback
): Promise<SwipeResult> {
  onProgress?.('starting', 'Initializing agentic swipe pipeline...', 0);

  // Phase 1: Run product analysis and landing analysis IN PARALLEL
  onProgress?.('phase1', 'Phase 1: Deep parallel analysis starting...', 5);

  const [productAnalysis, landingResult] = await Promise.all([
    analyzeProduct(input, onProgress),
    analyzeLanding(input.url, onProgress),
  ]);

  onProgress?.('phase1_complete', 'Phase 1 complete: Product & landing analyzed', 30);

  // Phase 2: CRO Strategy (depends on both Phase 1 results)
  onProgress?.('phase2', 'Phase 2: Designing CRO strategy...', 35);

  const croPlan = await planCROStructure(
    productAnalysis,
    landingResult.analysis,
    input,
    onProgress
  );

  onProgress?.('phase2_complete', 'Phase 2 complete: CRO blueprint ready', 70);

  // Phase 3: HTML Generation (depends on Phase 2)
  onProgress?.('phase3', 'Phase 3: Building HTML landing page...', 72);

  const html = await buildHTML(
    croPlan,
    landingResult.analysis,
    landingResult.originalHtml,
    onProgress
  );

  onProgress?.('complete', 'Agentic swipe complete!', 100);

  return {
    html,
    productAnalysis,
    landingAnalysis: landingResult.analysis,
    croPlan,
  };
}
