import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const ELEMENT_SYSTEM = `You are an expert front-end developer AND UI designer working inside a visual HTML editor for landing pages / quiz funnels.

The user has SELECTED one HTML element. They want you to either MODIFY it, or CREATE brand-new content in its place. Examples of what you must handle:
- "make me 3 buttons" / "add a Buy Now button" → generate polished buttons
- "background like a peach gradient" / "make the bg dark" → restyle the block's background
- "make me a chart / graph" → generate a chart
- "make text bigger", "center this", "add an icon", "turn this into a 2-column card" → restyle/restructure

You receive the selected element's HTML. Return the NEW HTML that will REPLACE the selected element (the editor swaps the whole selected element for your output).

CAPABILITIES & STYLE:
- You may add, remove, restyle or restructure freely to satisfy the request.
- When CREATING new UI (buttons, cards, badges, sections, charts), output complete, SELF-CONTAINED HTML with INLINE styles (style="...") so it renders identically in an offline export.
- For charts/graphs use INLINE SVG or pure-CSS bars — NEVER external libraries, NEVER <script>, NEVER <canvas>+JS (they don't run in the export). Make them look clean and modern.
- Match the look of the selected element / page when reasonable (colors, border-radius, font-family, spacing). If the request implies a color (e.g. "peach", "energy orange"), pick tasteful hex values.
- If you create several new elements, you may wrap them in a single <div> root — that's fine, the editor replaces the whole selected element.
- Keep the same root tag when you are only tweaking an existing element.

RULES:
1. Return ONLY raw HTML — no explanations, no markdown, no code fences.
2. NO <script> tags and NO external CSS/JS <link> (they are stripped on export). Inline everything.
3. Must be valid HTML that can directly replace the original element.
4. For new images use a real URL if given, otherwise a placeholder like https://placehold.co/600x400.
5. Preserve existing attributes/ids/classes when only modifying, unless the change requires otherwise.`;

const PAGE_SYSTEM = `You are an expert front-end developer in a visual HTML editor.
The user wants to insert or modify code at a specific location in the HTML document.

You MUST respond with ONLY a valid JSON object (no markdown, no code fences, no explanation). The JSON must have:

{
  "action": "insert_before" | "insert_after" | "replace",
  "target": "<the exact HTML tag/string to find, e.g. '</head>' or '</body>' or '<body>'>",
  "code": "<the HTML/script/style code to insert>"
}

Examples:
- "Add a tracking script before </head>" → {"action":"insert_before","target":"</head>","code":"<script>...</script>"}
- "Add this after <body>" → {"action":"insert_after","target":"<body>","code":"<div>...</div>"}
- "Insert Google Analytics before </body>" → {"action":"insert_before","target":"</body>","code":"<script async src=...></script>"}

RULES:
1. Return ONLY the JSON object, nothing else.
2. The "target" must be a string that exists in standard HTML documents (e.g. </head>, </body>, <body>, <head>).
3. The "code" must be the exact code to insert, properly escaped for JSON.
4. For "insert_before": code is placed right before the target.
5. For "insert_after": code is placed right after the target.`;

function isPageLevelRequest(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  const patterns = [
    /\b(head|body)\b.*\b(insert|add|put|place|before|after|inside|into|script|style|meta|link|tag)\b/,
    /\b(insert|add|put|place)\b.*\b(head|body|script|style|meta|tracking|pixel|analytics|tag)\b/,
    /\b(script|style|meta|link|tracking|pixel|analytics|gtag|facebook|google)\b.*\b(head|body|before|after)\b/,
    /<script|<style|<meta|<link/,
    /prima\s+d(i|el|ella)\s+(head|body|<\/head|<\/body)/i,
    /dopo\s+(head|body|<body|<\/body)/i,
    /sopra\s+(la\s+)?(head|body|<\/head)/i,
    /dentro\s+(la\s+)?(head|body)/i,
  ];
  return patterns.some(p => p.test(lower));
}

export async function POST(request: NextRequest) {
  try {
    const { elementHtml, fullHtml, instruction } = await request.json();

    if (!instruction) {
      return NextResponse.json({ error: 'instruction is required' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const anthropic = new Anthropic({ apiKey });
    const isPageLevel = isPageLevelRequest(instruction) || !elementHtml;

    if (isPageLevel) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        system: PAGE_SYSTEM,
        messages: [{ role: 'user', content: instruction }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      const raw = textBlock?.text?.trim() || '';
      const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

      try {
        const parsed = JSON.parse(cleaned);
        return NextResponse.json({
          scope: 'page',
          action: parsed.action,
          target: parsed.target,
          code: parsed.code,
        });
      } catch {
        return NextResponse.json({
          scope: 'page',
          action: 'insert_before',
          target: '</head>',
          code: cleaned,
        });
      }
    } else {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        system: ELEMENT_SYSTEM,
        messages: [{
          role: 'user',
          content: `Selected HTML element:\n\n${elementHtml}\n\nInstruction: ${instruction}`,
        }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      const result = textBlock?.text?.trim() || '';
      const html = result.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

      return NextResponse.json({ scope: 'element', html });
    }
  } catch (error) {
    console.error('Element AI edit error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
