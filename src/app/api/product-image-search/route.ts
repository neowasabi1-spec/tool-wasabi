import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { productName, brandName, catalogImageBase64 } = await request.json();

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    const geminiKey = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();
    const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();

    if (!geminiKey && !openaiKey) {
      return NextResponse.json({ error: 'No API key configured' }, { status: 500 });
    }

    const query = `${productName} ${brandName || ''} product`.trim();
    let imageUrl = '';

    if (geminiKey) {
      imageUrl = await searchWithGemini(geminiKey, query, catalogImageBase64);
    }

    if (!imageUrl && openaiKey) {
      imageUrl = await searchWithOpenAI(openaiKey, query);
    }

    return NextResponse.json({ imageUrl });
  } catch (error) {
    console.error('Product image search error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Image search failed' },
      { status: 500 }
    );
  }
}

async function searchWithGemini(apiKey: string, query: string, catalogImageBase64?: string): Promise<string> {
  const parts: Record<string, unknown>[] = [];

  if (catalogImageBase64) {
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: catalogImageBase64,
      },
    });
    parts.push({
      text: `This is a catalog page showing the product "${query}". 
Find a REAL, publicly accessible image URL for this exact product by searching online.
Return ONLY a JSON: {"imageUrl": "https://..."}
The URL must be a direct image link (ending in .jpg, .png, .webp or from a CDN like Amazon, eBay, etc).
If you cannot find one, return {"imageUrl": ""}`,
    });
  } else {
    parts.push({
      text: `Search the web and find a REAL, publicly accessible, direct image URL for this product: "${query}"
Return ONLY a JSON: {"imageUrl": "https://..."}
The URL must be a direct link to an image file. Prefer Amazon, official sites, or major retailers.
If you cannot find one, return {"imageUrl": ""}`,
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 512,
        },
      }),
    }
  );

  if (!response.ok) return '';

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text || '')
    .join('') || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.imageUrl || parsed.image_url || '';
    } catch { /* ignore */ }
  }

  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif)/i);
  if (urlMatch) return urlMatch[0];

  return '';
}

async function searchWithOpenAI(apiKey: string, query: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      instructions: `Find a REAL, WORKING, DIRECT image URL for this product. Return ONLY: {"imageUrl": "https://..."}
Prefer: Amazon CDN (m.media-amazon.com, images-na.ssl-images-amazon.com), official sites, eBay, major retailers.
If you cannot find one, return {"imageUrl": ""}`,
      input: `Find product image URL for: "${query}"`,
      tools: [{ type: 'web_search_preview' }],
    }),
  });

  if (!response.ok) return '';

  const data = await response.json();
  let text = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const content of (item.content || [])) {
        if (content.type === 'output_text') text += content.text;
      }
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.imageUrl || parsed.image_url || '';
    } catch { /* ignore */ }
  }

  return '';
}
