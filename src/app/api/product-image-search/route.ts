import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { productName, brandName } = await request.json();

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }

    const query = `${productName} ${brandName || ''} product official image`.trim();

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        instructions: `You are an image URL finder. The user will ask for a product image. You must search the web and find a REAL, WORKING, DIRECT image URL for the product (ending in .jpg, .png, .webp, or from a known CDN like images-na.ssl-images-amazon.com, m.media-amazon.com, i.ebayimg.com, etc.).

RULES:
- Return ONLY a JSON object: {"imageUrl": "https://..."}
- The URL must be a direct link to an image file, not a webpage
- Prefer images from: Amazon, official brand sites, major retailers
- The image must be a clear product photo on white/clean background
- If you cannot find a working image URL, return {"imageUrl": ""}
- Return ONLY the JSON. No explanations.`,
        input: `Find a real, working, direct image URL for this product: "${query}"`,
        tools: [{ type: 'web_search_preview' }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} – ${errText}`);
    }

    const data = await response.json();

    let text = '';
    for (const item of (data.output || [])) {
      if (item.type === 'message') {
        for (const content of (item.content || [])) {
          if (content.type === 'output_text') {
            text += content.text;
          }
        }
      }
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const imageUrl = parsed.imageUrl || parsed.image_url || '';
      return NextResponse.json({ imageUrl });
    }

    return NextResponse.json({ imageUrl: '' });
  } catch (error) {
    console.error('Product image search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Image search failed' },
      { status: 500 }
    );
  }
}
