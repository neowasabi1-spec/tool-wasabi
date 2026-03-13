import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

type OutputStack = 'pure_css' | 'bootstrap' | 'tailwind' | 'foundation' | 'bulma' | 'custom';

interface StackConfig {
  label: string;
  cdn: string;
  instructions: string;
}

const STACK_CONFIGS: Record<OutputStack, StackConfig> = {
  pure_css: {
    label: 'Pure CSS',
    cdn: '',
    instructions: `- Use ONLY HTML + pure CSS, NO frameworks.
- Include a <style> tag with ALL necessary styles.
- All CSS styles must be SCOPED using a wrapper with a unique class (e.g. .saved-section-XXXX).
- DO NOT use framework classes (no .container, .row, .col-*, etc. from Bootstrap/Tailwind).
- Write necessary media queries for responsiveness.`,
  },
  bootstrap: {
    label: 'Bootstrap 5',
    cdn: `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YcnS/1tMn4WRjNkMBfdzn0J6w/mK2+Gj0gE" crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"><\/script>`,
    instructions: `- Use Bootstrap 5 classes for layout, grid, typography, spacing, components.
- Use the Bootstrap grid system: .container, .row, .col-* with breakpoints (col-sm, col-md, col-lg, col-xl).
- Use Bootstrap utilities: text-center, d-flex, justify-content-*, align-items-*, p-*, m-*, bg-*, text-*, rounded, shadow, etc.
- Use Bootstrap components where appropriate: .btn, .card, .badge, .alert, .list-group, etc.
- INCLUDE a comment at the top indicating the Bootstrap 5 CDN dependency.
- Add the Bootstrap 5 CDN link in a comment <!-- Bootstrap 5 CDN required --> before the section.
- For interactivity (collapse, modal, tooltip), use Bootstrap 5 data-bs-* attributes.
- Any extra custom styles should go in a separate <style> tag with a scoped class.
- JavaScript must be ONLY vanilla JS or Bootstrap JS (no jQuery, no React, no Vue).`,
  },
  tailwind: {
    label: 'Tailwind CSS',
    cdn: `<script src="https://cdn.tailwindcss.com"><\/script>`,
    instructions: `- Use Tailwind CSS utility classes for ALL styling.
- Use the responsive system: sm:, md:, lg:, xl: prefixes.
- Use flex, grid, gap, padding, margin, text, bg, border, rounded, shadow utilities.
- DO NOT create a separate <style> tag — everything via inline Tailwind classes.
- INCLUDE a comment at the top: <!-- Tailwind CSS CDN required -->
- For hover, focus: use hover:, focus: prefixes.
- For dark mode: use dark: prefix if appropriate.`,
  },
  foundation: {
    label: 'Foundation 6',
    cdn: `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/foundation-sites@6.8.1/dist/css/foundation.min.css">`,
    instructions: `- Use Foundation 6 classes for layout and components.
- Use the Foundation grid system: .grid-container, .grid-x, .cell, .small-*, .medium-*, .large-*.
- Use Foundation components where appropriate: .button, .callout, .card, .badge, etc.
- INCLUDE a comment at the top: <!-- Foundation 6 CDN required -->
- Any extra custom styles should go in a separate <style> tag.`,
  },
  bulma: {
    label: 'Bulma',
    cdn: `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1.0.0/css/bulma.min.css">`,
    instructions: `- Use Bulma classes for layout and components.
- Use the Bulma column system: .columns, .column, .is-*, .is-offset-*.
- Use Bulma components: .button, .card, .tag, .notification, .box, .hero, .section, etc.
- Use Bulma utilities: has-text-centered, is-flex, is-justify-content-*, p-*, m-*, etc.
- INCLUDE a comment at the top: <!-- Bulma CSS CDN required -->
- Any extra custom styles should go in a separate <style> tag.`,
  },
  custom: {
    label: 'Custom',
    cdn: '',
    instructions: '',
  },
};

function buildSystemPrompt(stack: OutputStack, customInstructions?: string): string {
  const stackConfig = STACK_CONFIGS[stack];
  const stackBlock = stack === 'custom' && customInstructions
    ? customInstructions
    : stackConfig.instructions;

  return `You are an expert front-end developer specialized in landing pages and marketing funnels.
Your task is to REWRITE an HTML section extracted from a page, making it COMPLETELY STANDALONE and reusable.

OUTPUT STACK: ${stackConfig.label}
${stackBlock}

GENERAL RULES:
1. Return ONLY the HTML code of the rewritten section, NOTHING else — no text, explanations or markdown.
2. DO NOT add backticks, \`\`\`html or code blocks. Pure HTML output.
3. The section must work AUTONOMOUSLY as an HTML block insertable into any page.
4. Keep the visual design and original structure as faithfully as possible.
5. Keep images with absolute URLs.
6. Remove unnecessary scripts and inline event handlers (onclick, etc.).
7. Keep links (href) functional.
8. Ensure the section is RESPONSIVE and adapts to mobile/tablet/desktop.
9. If the section contains interactivity (accordion, tabs, toggle), recreate it with vanilla JavaScript${stack === 'bootstrap' ? ' or Bootstrap JS' : ''}.
10. The code must be CLEAN, well-indented and production-ready.`;
}

function cleanAiOutput(text: string): string {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:html)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  return cleaned.trim();
}

async function rewriteWithClaude(
  sectionHtml: string,
  systemPrompt: string,
  context?: string,
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userPrompt = `Rewrite this HTML section to make it completely standalone and reusable with the indicated stack.
${context ? `\nContext about the source page: ${context}` : ''}

HTML SECTION TO REWRITE:
${sectionHtml}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const result = response.content[0].type === 'text' ? response.content[0].text : '';
  return cleanAiOutput(result);
}

async function rewriteWithGemini(
  sectionHtml: string,
  systemPrompt: string,
  context?: string,
): Promise<string> {
  const apiKey = (process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY not configured');

  const userPrompt = `Rewrite this HTML section to make it completely standalone and reusable with the indicated stack.
${context ? `\nContext about the source page: ${context}` : ''}

HTML SECTION TO REWRITE:
${sectionHtml}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 32768, temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return cleanAiOutput(text);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      html: string;
      model?: 'claude' | 'gemini';
      context?: string;
      outputStack?: OutputStack;
      customStackInstructions?: string;
    };

    const { html, context, customStackInstructions } = body;

    if (!html || html.trim().length < 10) {
      return NextResponse.json({ error: 'HTML section missing or too short.' }, { status: 400 });
    }

    const useModel = body.model || 'claude';
    const stack: OutputStack = body.outputStack || 'pure_css';
    const systemPrompt = buildSystemPrompt(stack, customStackInstructions);

    let rewritten: string;

    if (useModel === 'gemini') {
      rewritten = await rewriteWithGemini(html, systemPrompt, context);
    } else {
      rewritten = await rewriteWithClaude(html, systemPrompt, context);
    }

    return NextResponse.json({
      success: true,
      html: rewritten,
      model: useModel,
      outputStack: stack,
      originalLength: html.length,
      rewrittenLength: rewritten.length,
    });
  } catch (error) {
    console.error('Rewrite section API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
