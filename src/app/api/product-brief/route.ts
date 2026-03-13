import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const SYSTEM_PROMPT = `You are an expert direct-response copywriter and ecommerce strategist.
Given product information, generate a comprehensive Product Research Brief following the "Ecom Domination" framework.

Output the brief in the EXACT structure below, filling each section with creative, strategic content based on the product data provided. Be specific, vivid, and persuasive. Write in English.

=== PRODUCT RESEARCH BRIEF ===

**TARGET MARKET:**
[Who is the ideal buyer? Demographics, psychographics, pain points, lifestyle]

**PRODUCT DETAILS (Name, What It Does, Delivery Mechanism):**
● Name: [product name]
● What It Does: [clear benefit-driven description]
● Delivery Mechanism: [how the product is delivered/used]

**UNIQUE MECHANISM OF THE PROBLEM:**
[What is the root cause of the problem this product solves? Explain the hidden mechanism that makes the problem persist. Use vivid, specific language.]

**UNIQUE MECHANISM OF THE SOLUTION:**
[How does this product solve the problem in a unique way? What is the proprietary/unique mechanism?]

**CHARACTERIZATIONS (Nicknames):**
For problems:
● [3-5 vivid nicknames for the problem/old solutions]
For solutions:
● [3-5 memorable nicknames for the product/mechanism]

**HOOKS (3-5 attention-grabbing opening lines):**
● [Story-driven hook]
● [Shock/alarm hook]
● [Comparison/contrast hook]

**TESTABLE PROOF:**
[A relatable analogy or everyday experience that proves the mechanism]

**POWERFUL METAPHORS:**
● [5-7 vivid metaphors that make the product/problem tangible]

**PARADOXICAL QUESTIONS:**
[1-2 questions that create cognitive dissonance and make the reader think]

**FASCINATIONS (Bullet points that create curiosity):**
● [4-6 fascination bullets that tease benefits without revealing everything]

**PROBLEM NARRATIVE:**
Early Warning Signs: [What first signals the problem?]
Worsening Situation: [How does it get worse?]
Crisis Point: [The breaking point]
Emotional Nadir: [The emotional low point - make it visceral]

**MYTHS & MISTAKES:**
Prevailing Myths: [What do people wrongly believe?]
Costly Mistakes: [What are people doing wrong?]

**UNIQUE MECHANISM PREVIEW (UMP):**
Discovery Narrative: [How was the solution discovered?]
UMP Trigger: [The paradoxical observation that leads to the mechanism]
UMP Explanation: [The scientific/logical explanation]
UMP Proof: [Evidence that backs up the mechanism]

**SOLUTION EXPLANATION:**
[Explain 3 specific principles/steps of how the product works. Be technical but accessible.]

**PROOF & VERIFICATION:**
[Studies, experts, real-world examples, testimonials framework]

**SUGGESTED AD ANGLES:**
● [3-5 different advertising angles with brief descriptions]`;

export async function POST(request: NextRequest) {
  try {
    const { product } = await request.json();

    if (!product || !product.name) {
      return NextResponse.json({ error: 'Product data is required' }, { status: 400 });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!anthropicKey && !openaiKey) {
      return NextResponse.json({ error: 'No AI API key configured' }, { status: 500 });
    }

    const benefitsText = (product.benefits || []).length > 0
      ? product.benefits.map((b: string, i: number) => `  ${i + 1}. ${b}`).join('\n')
      : '  No benefits specified';

    const userMessage = `Generate a complete Product Research Brief for:

Product Name: ${product.name}
Brand: ${product.brandName || 'N/A'}
Price: €${product.price || 0}
Description: ${product.description || 'No description'}
Benefits:
${benefitsText}
CTA: "${product.ctaText || 'Buy Now'}" → ${product.ctaUrl || 'N/A'}

Generate the full brief following the Ecom Domination framework. Be creative, specific, and strategic.`;

    let brief: string;

    if (anthropicKey) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} – ${errText}`);
      }

      const data = await response.json();
      brief = data.content?.[0]?.text || '';
    } else {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 4096,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} – ${errText}`);
      }

      const data = await response.json();
      brief = data.choices?.[0]?.message?.content || '';
    }

    return NextResponse.json({ brief });
  } catch (error) {
    console.error('Product brief error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Brief generation failed' }, { status: 500 });
  }
}
