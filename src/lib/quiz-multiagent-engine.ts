/**
 * Multi-Agent Gemini Engine
 *
 * Runs 4 specialized Gemini Vision agents in parallel, then a synthesis step.
 * Each agent gets the quiz screenshots + CSS tokens and produces a focused analysis.
 */

import type {
  VisualDesignSpec,
  UXFlowSpec,
  CROSpec,
  QuizLogicSpec,
  MasterSpec,
  ClonedQuizData,
  TextNode,
  VisualBlueprint,
  QuizBlueprint,
} from './quiz-multiagent-types';

import type { CssTokens } from '@/app/api/swipe-quiz/screenshot/route';

import {
  AGENT_VISUAL_DESIGN_PROMPT,
  AGENT_UX_FLOW_PROMPT,
  AGENT_CRO_PROMPT,
  AGENT_QUIZ_LOGIC_PROMPT,
  AGENT_SYNTHESIS_PROMPT,
  GEMINI_VISUAL_BLUEPRINT_PROMPT,
  GEMINI_QUIZ_LOGIC_BLUEPRINT_PROMPT,
} from './quiz-multiagent-prompts';

// =====================================================
// GEMINI API CALLER
// =====================================================

interface GeminiImagePart {
  inline_data: { mime_type: string; data: string };
}

interface GeminiTextPart {
  text: string;
}

type GeminiPart = GeminiImagePart | GeminiTextPart;

async function callGeminiVision(
  parts: GeminiPart[],
  apiKey: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: options?.temperature ?? 0.2,
          maxOutputTokens: options?.maxTokens ?? 8192,
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

  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
}

function parseJsonSafe(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try {
        return JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
      } catch { /* continue */ }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
      } catch { /* give up */ }
    }
    return {};
  }
}

// =====================================================
// CSS TOKENS FORMATTER
// =====================================================

function formatCssTokens(cssTokens: CssTokens | null): string {
  if (!cssTokens) return 'No CSS tokens available — rely on visual analysis only.';

  const lines: string[] = [];
  const printTokens = (label: string, tokens: CssTokens['body']) => {
    if (!tokens) return;
    lines.push(`${label}:`);
    lines.push(`  color: ${tokens.color}, background: ${tokens.bg}`);
    lines.push(`  font: ${tokens.fontFamily} ${tokens.fontSize} ${tokens.fontWeight}`);
    lines.push(`  line-height: ${tokens.lineHeight}`);
    lines.push(`  border-radius: ${tokens.borderRadius}`);
    lines.push(`  padding: ${tokens.padding}`);
    lines.push(`  max-width: ${tokens.maxWidth}`);
    if (tokens.boxShadow && tokens.boxShadow !== 'none') {
      lines.push(`  box-shadow: ${tokens.boxShadow}`);
    }
    if (tokens.border && tokens.border !== 'none') {
      lines.push(`  border: ${tokens.border}`);
    }
  };

  printTokens('BODY', cssTokens.body);
  printTokens('HEADING (h1/h2)', cssTokens.heading);
  printTokens('BUTTON (primary CTA)', cssTokens.button);
  printTokens('CARD/OPTION', cssTokens.card);
  printTokens('PROGRESS BAR', cssTokens.progressBar);
  printTokens('CONTAINER', cssTokens.container);
  printTokens('LINK', cssTokens.link);

  return lines.join('\n');
}

// =====================================================
// INDIVIDUAL AGENT RUNNERS
// =====================================================

export async function runVisualDesignAgent(
  screenshots: string[],
  cssTokens: CssTokens | null,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<VisualDesignSpec> {
  onProgress?.('Agent Visual: pixel-perfect design analysis...');

  const parts: GeminiPart[] = [];

  // Send up to 3 screenshots as images
  for (const ss of screenshots.slice(0, 3)) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  // Inject CSS tokens into the prompt
  const prompt = AGENT_VISUAL_DESIGN_PROMPT.replace('{{CSS_TOKENS}}', formatCssTokens(cssTokens));
  parts.push({ text: prompt });

  const rawText = await callGeminiVision(parts, apiKey, { temperature: 0.15 });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Agent Visual: completed');
  return parsed as unknown as VisualDesignSpec;
}

export async function runUXFlowAgent(
  screenshots: string[],
  stepsInfo: Array<{ index: number; title: string; type: string }>,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<UXFlowSpec> {
  onProgress?.('Agent UX Flow: flow and interactions analysis...');

  const parts: GeminiPart[] = [];

  // Send ALL screenshots in sequence (up to 10)
  for (const ss of screenshots.slice(0, 10)) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  // Add context about steps
  let contextText = `These ${screenshots.length} screenshots show the quiz funnel steps in order.\n`;
  contextText += `Known step info from crawl data:\n`;
  for (const step of stepsInfo) {
    contextText += `  Step ${step.index}: "${step.title}" [${step.type}]\n`;
  }
  contextText += '\n' + AGENT_UX_FLOW_PROMPT;

  parts.push({ text: contextText });

  const rawText = await callGeminiVision(parts, apiKey, { temperature: 0.2, maxTokens: 8192 });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Agent UX Flow: completed');
  return parsed as unknown as UXFlowSpec;
}

export async function runCROAgent(
  screenshots: string[],
  extractedTexts: Array<{ index: number; text: string; tag: string; context: string }>,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<CROSpec> {
  onProgress?.('Agent CRO: copy and conversion strategy analysis...');

  const parts: GeminiPart[] = [];

  // Send all screenshots
  for (const ss of screenshots.slice(0, 10)) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  // Add extracted text context
  let textContext = `These screenshots show each quiz step. Here are texts extracted from the DOM:\n`;
  for (const t of extractedTexts.slice(0, 100)) {
    textContext += `  [${t.tag}${t.context ? '.' + t.context : ''}] "${t.text.slice(0, 200)}"\n`;
  }
  textContext += '\n' + AGENT_CRO_PROMPT;

  parts.push({ text: textContext });

  const rawText = await callGeminiVision(parts, apiKey, { temperature: 0.3, maxTokens: 12000 });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Agent CRO: completed');
  return parsed as unknown as CROSpec;
}

export async function runQuizLogicAgent(
  screenshots: string[],
  stepsInfo: Array<{ index: number; title: string; type: string; options?: string[] }>,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<QuizLogicSpec> {
  onProgress?.('Agent Quiz Logic: reverse-engineering quiz mechanics...');

  const parts: GeminiPart[] = [];

  // Send all screenshots
  for (const ss of screenshots.slice(0, 10)) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  // Add step structure info
  let context = `These screenshots show each quiz step. Known step structure:\n`;
  for (const step of stepsInfo) {
    context += `  Step ${step.index}: "${step.title}" [${step.type}]`;
    if (step.options && step.options.length > 0) {
      context += ` Options: ${step.options.join(', ')}`;
    }
    context += '\n';
  }
  context += '\n' + AGENT_QUIZ_LOGIC_PROMPT;

  parts.push({ text: context });

  const rawText = await callGeminiVision(parts, apiKey, { temperature: 0.2, maxTokens: 10000 });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Agent Quiz Logic: completed');
  return parsed as unknown as QuizLogicSpec;
}

// =====================================================
// SYNTHESIS AGENT
// =====================================================

export async function runSynthesisAgent(
  visual: VisualDesignSpec,
  uxFlow: UXFlowSpec,
  cro: CROSpec,
  quizLogic: QuizLogicSpec,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<{
  conflicts_resolved: string[];
  confidence_score: number;
  warnings: string[];
  critical_elements_to_preserve: string[];
}> {
  onProgress?.('Agent Synthesis: unification and validation...');

  const parts: GeminiPart[] = [];

  let input = `=== AGENT 1 OUTPUT: Visual Design ===\n${JSON.stringify(visual, null, 1).slice(0, 8000)}\n\n`;
  input += `=== AGENT 2 OUTPUT: UX Flow ===\n${JSON.stringify(uxFlow, null, 1).slice(0, 6000)}\n\n`;
  input += `=== AGENT 3 OUTPUT: CRO & Copy ===\n${JSON.stringify(cro, null, 1).slice(0, 8000)}\n\n`;
  input += `=== AGENT 4 OUTPUT: Quiz Logic ===\n${JSON.stringify(quizLogic, null, 1).slice(0, 6000)}\n\n`;
  input += AGENT_SYNTHESIS_PROMPT;

  parts.push({ text: input });

  const rawText = await callGeminiVision(parts, apiKey, { temperature: 0.1 });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Agent Synthesis: completed');

  return {
    conflicts_resolved: Array.isArray(parsed.conflicts_resolved)
      ? (parsed.conflicts_resolved as string[])
      : [],
    confidence_score: typeof parsed.confidence_score === 'number'
      ? (parsed.confidence_score as number)
      : 0.7,
    warnings: Array.isArray(parsed.warnings)
      ? (parsed.warnings as string[])
      : [],
    critical_elements_to_preserve: Array.isArray(parsed.critical_elements_to_preserve)
      ? (parsed.critical_elements_to_preserve as string[])
      : [],
  };
}

// =====================================================
// FULL MULTI-AGENT PIPELINE
// =====================================================

export interface MultiAgentInput {
  screenshots: string[];
  cssTokens: CssTokens | null;
  stepsInfo: Array<{ index: number; title: string; type: string; options?: string[] }>;
  extractedTexts: Array<{ index: number; text: string; tag: string; context: string }>;
  geminiApiKey: string;
  onProgress?: (phase: string, message: string) => void;
}

export interface MultiAgentResult {
  masterSpec: MasterSpec;
  rawAgentOutputs: {
    visual: VisualDesignSpec;
    uxFlow: UXFlowSpec;
    cro: CROSpec;
    quizLogic: QuizLogicSpec;
  };
}

export async function runMultiAgentAnalysis(input: MultiAgentInput): Promise<MultiAgentResult> {
  const { screenshots, cssTokens, stepsInfo, extractedTexts, geminiApiKey, onProgress } = input;

  const progress = (phase: string, msg: string) => onProgress?.(phase, msg);

  // Run 4 agents in PARALLEL
  progress('parallel_agents', 'Launching 4 Gemini agents in parallel...');

  const [visual, uxFlow, cro, quizLogic] = await Promise.all([
    runVisualDesignAgent(
      screenshots, cssTokens, geminiApiKey,
      (msg) => progress('agent_visual', msg)
    ),
    runUXFlowAgent(
      screenshots, stepsInfo, geminiApiKey,
      (msg) => progress('agent_ux_flow', msg)
    ),
    runCROAgent(
      screenshots, extractedTexts, geminiApiKey,
      (msg) => progress('agent_cro', msg)
    ),
    runQuizLogicAgent(
      screenshots, stepsInfo, geminiApiKey,
      (msg) => progress('agent_quiz_logic', msg)
    ),
  ]);

  // Run synthesis agent
  const synthesis = await runSynthesisAgent(
    visual, uxFlow, cro, quizLogic, geminiApiKey,
    (msg) => progress('synthesizing', msg)
  );

  const masterSpec: MasterSpec = {
    visual,
    ux_flow: uxFlow,
    cro,
    quiz_logic: quizLogic,
    synthesis_notes: {
      conflicts_resolved: synthesis.conflicts_resolved,
      confidence_score: synthesis.confidence_score,
      warnings: synthesis.warnings,
      critical_elements_to_preserve: synthesis.critical_elements_to_preserve,
    },
    metadata: {
      original_url: '',
      funnel_name: '',
      total_steps: screenshots.length,
      analyzed_at: new Date().toISOString(),
      agents_used: ['visual_design', 'ux_flow', 'cro_copy', 'quiz_logic', 'synthesis'],
    },
  };

  return {
    masterSpec,
    rawAgentOutputs: { visual, uxFlow, cro, quizLogic },
  };
}

// =====================================================
// V2 PIPELINE — Visual Replication (2 Gemini calls)
// =====================================================

export interface VisualBlueprintInput {
  screenshots: string[];
  cssTokens: CssTokens | null;
  geminiApiKey: string;
  onProgress?: (msg: string) => void;
}

export async function runVisualBlueprintAnalysis(
  input: VisualBlueprintInput,
): Promise<VisualBlueprint> {
  const { screenshots, cssTokens, geminiApiKey, onProgress } = input;
  onProgress?.(`Gemini Vision: visual blueprint analysis (${screenshots.length} screenshots)...`);

  const parts: GeminiPart[] = [];

  // For visual design, send a representative sample: first 3 + last 2 + evenly spaced middle
  // This captures intro design, question variations, and result/checkout pages
  let visualScreenshots = screenshots;
  if (screenshots.length > 8) {
    const first3 = screenshots.slice(0, 3);
    const last2 = screenshots.slice(-2);
    const middle = screenshots.slice(3, -2);
    const step = Math.max(1, Math.floor(middle.length / 3));
    const middlePicks = middle.filter((_, i) => i % step === 0).slice(0, 3);
    visualScreenshots = [...first3, ...middlePicks, ...last2];
  }

  for (const ss of visualScreenshots) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  const prompt = GEMINI_VISUAL_BLUEPRINT_PROMPT.replace('{{CSS_TOKENS}}', formatCssTokens(cssTokens));
  parts.push({ text: prompt });

  onProgress?.(`Design analysis from ${visualScreenshots.length} selected screenshots...`);
  const rawText = await callGeminiVision(parts, geminiApiKey, {
    temperature: 0.15,
    maxTokens: 12000,
  });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Visual blueprint completed');
  return parsed as unknown as VisualBlueprint;
}

export interface QuizBlueprintInput {
  screenshots: string[];
  stepsInfo: Array<{ index: number; title: string; type: string; options?: string[] }>;
  geminiApiKey: string;
  onProgress?: (msg: string) => void;
}

export async function runQuizLogicBlueprintAnalysis(
  input: QuizBlueprintInput,
): Promise<QuizBlueprint> {
  const { screenshots, stepsInfo, geminiApiKey, onProgress } = input;
  onProgress?.(`Gemini Vision: quiz logic and content analysis (${screenshots.length} screenshots)...`);

  const parts: GeminiPart[] = [];

  // Send ALL screenshots — Gemini needs to see every step to extract questions/options/content
  // Gemini 2.5 Flash supports up to 3600 images, so even 30+ is fine
  for (const ss of screenshots) {
    parts.push({ inline_data: { mime_type: 'image/png', data: ss } });
  }

  // Build steps info string
  let stepsInfoStr = '';
  for (const step of stepsInfo) {
    stepsInfoStr += `Step ${step.index}: "${step.title}" [${step.type}]`;
    if (step.options && step.options.length > 0) {
      stepsInfoStr += ` — Options: ${step.options.join(', ')}`;
    }
    stepsInfoStr += '\n';
  }

  const prompt = GEMINI_QUIZ_LOGIC_BLUEPRINT_PROMPT.replace('{{STEPS_INFO}}', stepsInfoStr || 'No crawl data available — analyze screenshots only.');
  parts.push({ text: prompt });

  onProgress?.(`Content analysis from ${screenshots.length} screenshots...`);
  const rawText = await callGeminiVision(parts, geminiApiKey, {
    temperature: 0.2,
    maxTokens: 32000,
  });
  const parsed = parseJsonSafe(rawText);

  onProgress?.('Quiz logic blueprint completed');
  return parsed as unknown as QuizBlueprint;
}

// =====================================================
// HTML CLONER (uses Playwright) — kept for backward compatibility
// =====================================================

export async function cloneQuizHtml(url: string): Promise<{
  clonedData: ClonedQuizData;
  textNodes: TextNode[];
  cssTokens: CssTokens | null;
}> {
  const { launchBrowser } = await import('@/lib/get-browser');

  const browser = await launchBrowser();

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 25000 });
    await page.waitForTimeout(3000);

    // Scroll to trigger lazy content
    await page.evaluate(async () => {
      const step = window.innerHeight;
      const max = document.body.scrollHeight;
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);

    // Dismiss popups
    try {
      const dismissSelectors = [
        '[class*="cookie"] button', '[class*="consent"] button',
        '[class*="popup"] [class*="close"]', '[class*="modal"] [class*="close"]',
        'button[aria-label="Close"]', 'button[aria-label="Chiudi"]',
      ];
      for (const sel of dismissSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    } catch { /* ignore */ }

    // Extract cloned HTML with inlined CSS
    const cloneResult = await page.evaluate((pageUrl: string) => {
      function abs(relative: string): string {
        if (!relative || relative.startsWith('data:') || relative.startsWith('blob:') ||
            relative.startsWith('#') || relative.startsWith('mailto:') || relative.startsWith('tel:') ||
            relative.startsWith('javascript:')) return relative;
        if (relative.startsWith('http://') || relative.startsWith('https://')) return relative;
        try { return new URL(relative, pageUrl).href; } catch { return relative; }
      }

      // Collect ALL CSS
      const allCss: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          let cssText = rules.map(r => r.cssText).join('\n');
          cssText = cssText.replace(/url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi, (_m: string, u: string) => {
            const baseUrl = sheet.href || pageUrl;
            try { return `url("${new URL(u.trim(), baseUrl).href}")`; } catch { return `url("${u}")`; }
          });
          if (cssText.trim()) allCss.push(cssText);
        } catch { /* CORS */ }
      }

      const docClone = document.documentElement.cloneNode(true) as HTMLElement;

      // Remove ALL scripts — both inline and external
      // Inline scripts won't work outside original context
      // External scripts point to original domain and won't load
      // Claude will write fresh JS from scratch based on the MasterSpec
      const scriptTexts: string[] = [];
      docClone.querySelectorAll('script').forEach(s => {
        if (s.textContent && s.textContent.length > 50 && !s.src) {
          scriptTexts.push(s.textContent);
        }
        s.remove();
      });

      // Remove event handlers
      docClone.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
          if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
        });
      });

      // Remove stylesheet links
      docClone.querySelectorAll('link[rel="stylesheet"]').forEach(l => l.remove());

      // Fix all URLs to absolute
      docClone.querySelectorAll('[src],[href],[poster],[data-src],[data-lazy-src],[data-original],[data-bg],[action]').forEach(el => {
        ['src', 'href', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'action'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('blob:') && !val.startsWith('#') && !val.startsWith('mailto:')) {
            el.setAttribute(attr, abs(val));
          }
        });
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          el.setAttribute('srcset', srcset.split(',').map((e: string) => {
            const p = e.trim().split(/\s+/); if (p[0]) p[0] = abs(p[0]); return p.join(' ');
          }).join(', '));
        }
      });

      // Fix inline style url()
      docClone.querySelectorAll('[style]').forEach(el => {
        const s = el.getAttribute('style') || '';
        if (s.includes('url(')) {
          el.setAttribute('style', s.replace(/url\(\s*["']?(?!data:|https?:|blob:)([^"')]+)["']?\s*\)/gi,
            (_m: string, u: string) => `url("${abs(u.trim())}")`));
        }
      });

      // Inject consolidated CSS
      const head = docClone.querySelector('head');
      if (head && allCss.length > 0) {
        head.querySelectorAll('style').forEach(s => s.remove());
        const styleEl = document.createElement('style');
        styleEl.textContent = allCss.join('\n\n');
        const after = head.querySelector('meta[charset]')?.nextSibling || head.firstChild;
        if (after) head.insertBefore(styleEl, after); else head.appendChild(styleEl);
      }

      // Mark original inline scripts as non-functional reference
      // Claude will remove these and write new JS from scratch
      const body = docClone.querySelector('body');
      if (body && scriptTexts.length > 0) {
        const comment = document.createComment(
          ' ORIGINAL SCRIPTS (non-functional after cloning — Claude must rewrite JS from scratch) '
        );
        body.appendChild(comment);
      }

      const finalHtml = '<!DOCTYPE html>\n' + docClone.outerHTML;

      return {
        html: finalHtml,
        title: document.title || '',
        cssCount: allCss.length,
        imgCount: docClone.querySelectorAll('img').length,
      };
    }, url);

    // Extract text nodes with classification
    const textNodes: TextNode[] = await page.evaluate(() => {
      const skipTags: Record<string, boolean> = {
        SCRIPT: true, STYLE: true, NOSCRIPT: true, IFRAME: true, SVG: true, META: true, LINK: true, BR: true, HR: true, IMG: true, INPUT: true, SELECT: true, TEXTAREA: true,
      };
      const texts: TextNode[] = [];
      let idx = 0;
      const extracted = new Set<string>();
      const allEls = document.body.querySelectorAll('*');

      allEls.forEach((el) => {
        if (skipTags[el.tagName]) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

        let directText = '';
        el.childNodes.forEach(node => {
          if (node.nodeType === 3) directText += node.textContent || '';
        });
        directText = directText.replace(/\s+/g, ' ').trim();

        if (directText.length < 2 || !directText.match(/[a-zA-Z\u00C0-\u024F]/)) return;
        if (extracted.has(directText)) return;
        if (directText.includes('{') || directText.includes('}') || directText.includes('=>')) return;
        if (directText.startsWith('http') || directText.startsWith('//')) return;

        extracted.add(directText);
        const tag = el.tagName.toLowerCase();
        const cls = el.getAttribute('class') || '';
        const parentCls = el.parentElement?.getAttribute('class') || '';

        const isHeadline = /^h[1-3]$/i.test(tag) || /title|heading|headline|question/i.test(cls);
        const isCta = /^(button|a)$/i.test(tag) && (/btn|button|cta|submit|start|next|continue/i.test(cls) || directText.length < 40);
        const isOption = /option|answer|choice|card/i.test(cls) || /option|answer|choice/i.test(parentCls);
        const isSocialProof = /social|proof|review|rating|testimonial|count/i.test(cls);
        const isUrgency = /urgent|countdown|timer|limited|hurry|scarcity/i.test(cls) || /solo|rimast|ultim|offerta|scade/i.test(directText.toLowerCase());

        texts.push({
          index: idx++,
          originalText: directText,
          tagName: tag,
          fullTag: `<${tag}${cls ? ` class="${cls.slice(0, 100)}"` : ''}>`,
          classes: cls.slice(0, 200),
          parentClasses: parentCls.slice(0, 200),
          position: Math.round(rect.top),
          isHeadline,
          isCta,
          isOption,
          isSocialProof,
          isUrgency,
          context: tag,
        });
      });

      // Also extract alt/title/placeholder attributes
      document.querySelectorAll('[alt],[title],[placeholder],[aria-label]').forEach(el => {
        ['alt', 'title', 'placeholder', 'aria-label'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && val.length >= 3 && val.match(/[a-zA-Z\u00C0-\u024F]/) && !extracted.has(val) && !val.startsWith('http')) {
            extracted.add(val);
            texts.push({
              index: idx++,
              originalText: val,
              tagName: '',
              fullTag: `${attr}="${val}"`,
              classes: '',
              parentClasses: '',
              position: 0,
              isHeadline: false,
              isCta: false,
              isOption: false,
              isSocialProof: false,
              isUrgency: false,
              context: `attr:${attr}`,
            });
          }
        });
      });

      return texts;
    });

    // Extract CSS tokens
    let cssTokens: CssTokens | null = null;
    try {
      cssTokens = await page.evaluate(() => {
        function getTokens(selectors: string[]) {
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const s = window.getComputedStyle(el);
            return {
              color: s.color, bg: s.backgroundColor, fontFamily: s.fontFamily,
              fontSize: s.fontSize, fontWeight: s.fontWeight, borderRadius: s.borderRadius,
              padding: s.padding, boxShadow: s.boxShadow, border: s.border,
              lineHeight: s.lineHeight, maxWidth: s.maxWidth,
            };
          }
          return null;
        }
        return {
          body: getTokens(['body']),
          heading: getTokens(['h1', 'h2', '[class*="title"]', '[class*="heading"]', '[class*="headline"]', '[class*="question"]']),
          button: getTokens(['button[class*="cta"]', 'button[class*="primary"]', 'button[class*="btn"]', 'a[class*="cta"]', 'a[class*="btn"]', 'button:not([class*="close"]):not([class*="dismiss"])']),
          card: getTokens(['[class*="option"]', '[class*="card"]', '[class*="answer"]', '[class*="choice"]', '[class*="item"]']),
          progressBar: getTokens(['[class*="progress"]', '[role="progressbar"]', '[class*="step-indicator"]']),
          container: getTokens(['[class*="container"]', '[class*="wrapper"]', 'main', '[class*="content"]', '[class*="quiz"]']),
          link: getTokens(['a[href]', '[class*="link"]']),
        };
      });
    } catch { /* best effort */ }

    return {
      clonedData: {
        html: cloneResult.html,
        title: cloneResult.title,
        cssCount: cloneResult.cssCount,
        imgCount: cloneResult.imgCount,
        renderedSize: cloneResult.html.length,
      },
      textNodes,
      cssTokens,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
