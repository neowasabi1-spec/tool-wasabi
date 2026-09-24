import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeCheckoutMode, withCheckoutRules } from '@/lib/checkout-modes';
import { stripRuntimeConflicts } from '@/lib/wasabi-checkout-contract';
import {
  applyTextSwap,
  extractVisibleSnippets,
  isHugeAiHtml,
  parseTextSwapInstruction,
} from '@/lib/ai-html-text-swap';

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

const PATCH_SYSTEM = `You edit COPY on a large landing page. You must NOT rewrite HTML.

Return ONLY a JSON object (no markdown):
{"replacements":[{"from":"exact visible text","to":"new text"}]}

Rules:
- "from" must be copied EXACTLY from the snippets/excerpt the user sent.
- Only include strings that actually change.
- Prefer brand/name/phrase swaps over restyling.
- If the instruction is a rename (change X with Y), return one replacement {from:X,to:Y}.
- Empty replacements array if you cannot do it safely.`;

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

function parsePatchJson(raw: string): Array<{ from: string; to: string }> {
  const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { replacements?: Array<{ from?: string; to?: string }> };
    const list = Array.isArray(parsed?.replacements) ? parsed.replacements : [];
    return list
      .map((r) => ({ from: String(r?.from || '').trim(), to: String(r?.to ?? '') }))
      .filter((r) => r.from.length >= 2);
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      elementHtml,
      instruction,
      checkoutMode,
      mode,
      snippets,
      excerpt,
    } = body as {
      elementHtml?: string;
      instruction?: string;
      checkoutMode?: string;
      mode?: string;
      snippets?: string[];
      excerpt?: string;
    };

    if (!instruction) {
      return NextResponse.json({ error: 'instruction is required' }, { status: 400 });
    }

    const swap = parseTextSwapInstruction(instruction);
    if (swap && typeof elementHtml === 'string' && elementHtml.length > 0) {
      const applied = applyTextSwap(elementHtml, swap.from, swap.to);
      if (applied.count > 0) {
        return NextResponse.json({
          scope: 'element',
          html: applied.html,
          applied: { from: swap.from, to: swap.to, count: applied.count },
        });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const anthropic = new Anthropic({ apiKey });
    const huge = isHugeAiHtml(elementHtml, undefined) || mode === 'patches';
    const isPageLevel = mode !== 'patches' && (isPageLevelRequest(instruction) || !elementHtml) && !huge;

    const elementSystem = withCheckoutRules(ELEMENT_SYSTEM, checkoutMode);
    const pageSystem = withCheckoutRules(PAGE_SYSTEM, checkoutMode);
    const isWasabi = normalizeCheckoutMode(checkoutMode) === 'wasabi';

    // Both scopes return a FRAGMENT, so the whole-page rules (one payment
    // mount, one email field) don't apply — but §1.4 does, and it is the one
    // that broke a live checkout: a hand-written <script src=".../wasabi-
    // checkout.js"> suppresses the CRM's own injection because ensureScript()
    // matches the raw text. Asking was not enough; strip it.
    const guard = (fragment: string): string => {
      if (!isWasabi) return fragment;
      const stripped = stripRuntimeConflicts(fragment);
      if (stripped.repairs.length) {
        console.log(`[ai-edit-element] WasabiCRM repairs: ${stripped.repairs.join(' | ')}`);
      }
      return stripped.html;
    };

    if (huge) {
      const list = Array.isArray(snippets) && snippets.length
        ? snippets.map(String).slice(0, 80)
        : extractVisibleSnippets(String(elementHtml || excerpt || ''), 80);
      const clip = String(excerpt || elementHtml || '').slice(0, 6000);
      if (swap) {
        return NextResponse.json({
          scope: 'patches',
          replacements: [{ from: swap.from, to: swap.to }],
        });
      }
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        system: PATCH_SYSTEM,
        messages: [{
          role: 'user',
          content: `Instruction: ${instruction}\n\nVisible snippets:\n${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nExcerpt:\n${clip}`,
        }],
      });
      const textBlock = response.content.find(b => b.type === 'text');
      const replacements = parsePatchJson(textBlock?.text?.trim() || '');
      return NextResponse.json({ scope: 'patches', replacements });
    }

    if (isPageLevel) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        system: pageSystem,
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
          code: guard(String(parsed.code ?? '')),
        });
      } catch {
        return NextResponse.json({
          scope: 'page',
          action: 'insert_before',
          target: '</head>',
          code: guard(cleaned),
        });
      }
    } else {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        system: elementSystem,
        messages: [{
          role: 'user',
          content: `Selected HTML element:\n\n${elementHtml}\n\nInstruction: ${instruction}`,
        }],
      });

      const textBlock = response.content.find(b => b.type === 'text');
      const result = textBlock?.text?.trim() || '';
      const html = result.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

      return NextResponse.json({ scope: 'element', html: guard(html) });
    }
  } catch (error) {
    console.error('Element AI edit error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
