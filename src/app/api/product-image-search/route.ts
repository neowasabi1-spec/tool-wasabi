import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 45;
export const dynamic = 'force-dynamic';

const BUCKET_NAME = 'product-catalog-images';

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  return createClient(url, key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureBucket(sb: any) {
  const { data } = await sb.storage.getBucket(BUCKET_NAME);
  if (!data) {
    await sb.storage.createBucket(BUCKET_NAME, { public: true });
  }
}

async function downloadAndUpload(imageUrl: string, productName: string): Promise<string> {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return '';

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return '';

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) return '';

    const sb = getSupabase();
    await ensureBucket(sb);

    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
    const filePath = `products/${safeName}-${Date.now()}.${ext}`;

    const { error } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, { contentType, upsert: false });

    if (error) return '';

    const { data } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
    return data.publicUrl;
  } catch {
    return '';
  }
}

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
    let foundUrl = '';

    if (geminiKey) {
      foundUrl = await searchWithGemini(geminiKey, query, catalogImageBase64);
    }

    if (!foundUrl && openaiKey) {
      foundUrl = await searchWithOpenAI(openaiKey, query);
    }

    if (!foundUrl) {
      return NextResponse.json({ imageUrl: '' });
    }

    const proxiedUrl = await downloadAndUpload(foundUrl, productName);

    return NextResponse.json({ imageUrl: proxiedUrl || foundUrl });
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
      inline_data: { mime_type: 'image/jpeg', data: catalogImageBase64 },
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
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      }),
    }
  );

  if (!response.ok) return '';

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text || '')
    .join('') || '';

  return extractImageUrl(text);
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
Prefer: Amazon CDN, official sites, eBay, major retailers.
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

  return extractImageUrl(text);
}

function extractImageUrl(text: string): string {
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
