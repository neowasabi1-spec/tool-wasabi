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
    console.log(`[downloadAndUpload] Downloading: ${imageUrl}`);
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': new URL(imageUrl).origin + '/',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    if (!res.ok) {
      console.log(`[downloadAndUpload] HTTP ${res.status} for ${imageUrl}`);
      return '';
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[downloadAndUpload] Downloaded ${buffer.length} bytes, type: ${contentType}`);

    if (buffer.length < 500) {
      console.log(`[downloadAndUpload] Image too small (${buffer.length} bytes)`);
      return '';
    }

    const sb = getSupabase();
    await ensureBucket(sb);

    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
    const filePath = `products/${safeName}-${Date.now()}.${ext}`;

    const uploadContentType = contentType.startsWith('image/') ? contentType : 'image/jpeg';

    const { error } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, { contentType: uploadContentType, upsert: false });

    if (error) {
      console.error(`[downloadAndUpload] Upload error:`, error);
      return '';
    }

    const { data } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
    console.log(`[downloadAndUpload] Uploaded: ${data.publicUrl}`);
    return data.publicUrl;
  } catch (err) {
    console.error(`[downloadAndUpload] Error:`, err);
    return '';
  }
}

export async function POST(request: NextRequest) {
  try {
    const { productName, brandName, catalogImageBase64, directImageUrl } = await request.json();

    if (!productName) {
      return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
    }

    if (directImageUrl) {
      console.log(`Proxying direct URL for "${productName}": ${directImageUrl}`);
      const proxiedUrl = await downloadAndUpload(directImageUrl, productName);
      if (proxiedUrl) return NextResponse.json({ imageUrl: proxiedUrl });
    }

    const geminiKey = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();
    const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();

    if (!geminiKey && !openaiKey) {
      return NextResponse.json({ imageUrl: '' });
    }

    const query = `${productName} ${brandName || ''} product`.trim();
    let foundUrl = '';

    if (geminiKey) {
      foundUrl = await searchWithGemini(geminiKey, query, catalogImageBase64);
      console.log(`Gemini search for "${query}": ${foundUrl || 'not found'}`);
    }

    if (!foundUrl && openaiKey) {
      foundUrl = await searchWithOpenAI(openaiKey, query);
      console.log(`OpenAI search for "${query}": ${foundUrl || 'not found'}`);
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
      text: `Search for product images of "${query}" online.
I need a DIRECT image URL — a URL that loads as an image in a browser (not a webpage).

LOOK FOR THESE TYPES OF URLs:
- Amazon product images: https://m.media-amazon.com/images/I/...jpg
- eBay images: https://i.ebayimg.com/images/g/...
- Shopify CDN: https://cdn.shopify.com/s/files/...
- iHerb images: https://cloudinary.images-iherb.com/...
- Any .jpg, .png, .webp direct image link

Search for the product on Amazon, iHerb, eBay, or the manufacturer's website.
Return ONLY: {"imageUrl": "https://direct-link-to-image.jpg"}
If you cannot find a direct image link, return {"imageUrl": ""}`,
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
      instructions: `Find a REAL, WORKING, DIRECT image URL for this product. Search on Amazon, iHerb, eBay, or manufacturer sites. The URL must load as an image directly (not a webpage). Look for URLs like https://m.media-amazon.com/images/... or similar CDN links. Return ONLY: {"imageUrl": "https://..."}. If not found: {"imageUrl": ""}`,
      input: `Find a direct product image URL for: "${query}". Search on Amazon, iHerb, or Google Images.`,
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
