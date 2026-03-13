import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const MODEL = 'gpt-4.1';

const VISUAL_PROMPT = `You are an expert in funnel design, UI/UX design and conversion rate optimization.

Based on the reverse engineering analysis of a funnel and the regenerated funnel proposal, generate a complete and visual HTML mockup showing what the REGENERATED and OPTIMIZED FUNNEL could look like.

The HTML mockup must show:

1. **Header Hero** — Title of the regenerated funnel with a brief description of the concept
2. **Flow Diagram** — Visual diagram of the step-by-step journey with connecting arrows
3. **Card for each Step** — For each step of the regenerated funnel, show:
   - Step number and type (with icon/color)
   - Proposed headline and subheadline
   - Key elements (CTA, form, trust signals)
   - Summary body copy
   - Note on why it is improved compared to the original
4. **Improvements Section** — List of improvements applied compared to the original funnel
5. **Scoring Comparison** — Before/after comparison of effectiveness scores

Technical requirements:
- A single self-contained HTML page
- Use Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- Modern, professional design with gradients, shadows, rounded corners
- Color palette: indigo/violet/purple as primary colors
- Responsive (works on both desktop and mobile)
- Icons via Unicode emoji (no external dependencies)
- Font: system-ui

IMPORTANT: Respond ONLY with the complete HTML code, starting from <!DOCTYPE html>. No comments, no markdown, no code blocks. Only pure HTML.`;

export async function POST(request: NextRequest) {
  try {
    const { analysis, funnelName } = await request.json();

    if (!analysis) {
      return NextResponse.json(
        { error: 'Analysis data is required' },
        { status: 400 }
      );
    }

    const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY not configured' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: VISUAL_PROMPT },
        {
          role: 'user',
          content: `Generate the visual HTML mockup of the regenerated funnel for "${funnelName || 'Funnel'}".

Here is the complete analysis of the original funnel and the regeneration proposal:

${JSON.stringify(analysis, null, 2)}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 16384,
    });

    let html = completion.choices[0]?.message?.content ?? '';
    const match = html.match(/```(?:html)?\s*([\s\S]*?)```/);
    if (match) html = match[1].trim();

    if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
      html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.tailwindcss.com"><\/script><title>Regenerated Funnel</title></head><body class="bg-gray-50">${html}</body></html>`;
    }

    return NextResponse.json({
      success: true,
      html,
      usage: completion.usage,
    });
  } catch (error) {
    console.error('[reverse-funnel/generate-visual] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Error in visual generation',
      },
      { status: 500 }
    );
  }
}
