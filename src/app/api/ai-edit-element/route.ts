import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const ELEMENT_SYSTEM = `You are an expert front-end developer in a visual HTML editor.
The user selected an HTML element and wants to modify it.

RULES:
1. Return ONLY the modified HTML element — no explanations, no markdown, no code fences.
2. Keep the same root tag unless explicitly asked to change it.
3. Preserve existing attributes unless modification is requested.
4. Be precise — modify only what is asked.
5. Return valid HTML that can replace the original element.`;

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
        model: 'claude-sonnet-4-20250514',
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
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
