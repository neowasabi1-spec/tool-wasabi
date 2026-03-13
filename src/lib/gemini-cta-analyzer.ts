/**
 * Screenshot analysis with Gemini to extract main CTAs to the next step.
 * Used by the agentic browser to decide which CTA to click.
 */
const CTA_PROMPT = `You are analyzing a screenshot of a marketing funnel page. Your job is to identify the MAIN call-to-action (CTA) buttons/links that move the user to the NEXT STEP of the funnel.

IMPORTANT RULES:
1. Return the EXACT visible text on the buttons/links (what is written on the button, character by character)
2. Focus on PRIMARY CTAs only - the main action the page wants the user to take
3. Prioritize: "Buy Now", "Add to Cart", "Continue", "Next", "Get Started", "Take Quiz", "See Results", "Claim Offer", "Order Now", "Checkout", "Submit", "Sign Up", etc.
4. EXCLUDE: navigation menu items, footer links, privacy/cookie links, "Go Back", social media links, login links
5. If there's a quiz or multi-step form, identify the "Next" or "Continue" or answer option buttons
6. For product pages, identify the "Add to Cart" or "Buy Now" button
7. Return between 1 and 3 CTAs maximum, ordered by importance (most important first)

Return ONLY a valid JSON object:
{"next_step_ctas": ["Exact Button Text 1", "Exact Button Text 2"]}

If no forward-moving CTAs exist, return: {"next_step_ctas": []}`;

export async function analyzeCtasWithGemini(
  screenshotBase64: string,
  context: string,
  apiKey: string
): Promise<string[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
              { text: `${CTA_PROMPT}\n\nContext: ${context}` },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.1,
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  console.log('[gemini-cta] Raw response:', text.slice(0, 500));

  try {
    const parsed = JSON.parse(text.trim()) as { next_step_ctas?: unknown };
    const arr = parsed.next_step_ctas;
    if (Array.isArray(arr)) {
      const result = arr
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((s) => s.trim());
      console.log('[gemini-cta] Parsed CTAs:', JSON.stringify(result));
      return result;
    }
    console.log('[gemini-cta] next_step_ctas is not an array:', typeof arr);
    return [];
  } catch (parseErr) {
    console.error('[gemini-cta] JSON parse error:', parseErr, '| raw:', text.slice(0, 200));
    // Try to extract from malformed JSON
    const match = text.match(/"next_step_ctas"\s*:\s*\[([^\]]*)\]/);
    if (match) {
      try {
        const arr = JSON.parse(`[${match[1]}]`);
        if (Array.isArray(arr)) {
          return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim());
        }
      } catch {
        /* give up */
      }
    }
    return [];
  }
}
