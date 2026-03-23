import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

export const maxDuration = 60;
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

export async function POST(req: NextRequest) {
  try {
    const { pageBase64, productName } = await req.json();

    if (!pageBase64 || !productName) {
      return NextResponse.json({ error: 'pageBase64 and productName are required' }, { status: 400 });
    }

    const geminiKey = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();

    if (!geminiKey) {
      return NextResponse.json({ error: 'GOOGLE_GEMINI_API_KEY not configured' }, { status: 500 });
    }

    const bbox = await getProductImageBBox(geminiKey, pageBase64, productName);

    if (!bbox) {
      return NextResponse.json({ imageUrl: '' });
    }

    const pageBuffer = Buffer.from(pageBase64, 'base64');
    const metadata = await sharp(pageBuffer).metadata();
    const imgWidth = metadata.width || 1000;
    const imgHeight = metadata.height || 1000;

    const left = Math.max(0, Math.round((bbox.x / 1000) * imgWidth));
    const top = Math.max(0, Math.round((bbox.y / 1000) * imgHeight));
    const width = Math.min(imgWidth - left, Math.round((bbox.w / 1000) * imgWidth));
    const height = Math.min(imgHeight - top, Math.round((bbox.h / 1000) * imgHeight));

    if (width < 20 || height < 20) {
      return NextResponse.json({ imageUrl: '' });
    }

    const croppedBuffer = await sharp(pageBuffer)
      .extract({ left, top, width, height })
      .resize({ width: Math.min(width, 800), withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const sb = getSupabase();
    await ensureBucket(sb);

    const safeName = productName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
    const filePath = `products/${safeName}-${Date.now()}.jpg`;

    const { error: uploadError } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, croppedBuffer, { contentType: 'image/jpeg', upsert: false });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return NextResponse.json({ imageUrl: '' });
    }

    const { data } = sb.storage.from(BUCKET_NAME).getPublicUrl(filePath);
    return NextResponse.json({ imageUrl: data.publicUrl });
  } catch (err) {
    console.error('Extract product image error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to extract image' },
      { status: 500 }
    );
  }
}

interface BBox { x: number; y: number; w: number; h: number }

async function getProductImageBBox(
  apiKey: string,
  pageBase64: string,
  productName: string
): Promise<BBox | null> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: { mime_type: 'image/jpeg', data: pageBase64 },
            },
            {
              text: `Look at this product catalog page. Find the main PRODUCT IMAGE (the photo/picture of the product itself — like a bottle, box, packaging, supplement container, etc.) for "${productName}".

Do NOT select the entire page. Do NOT select text areas, tables, or decorative images. Select ONLY the product photo/packaging image.

Return the bounding box of the product image as a JSON object with coordinates in a 0-1000 scale (where 0,0 is top-left and 1000,1000 is bottom-right):
{"x": <left>, "y": <top>, "w": <width>, "h": <height>}

If there are multiple product images, pick the largest/main one (usually the product bottle or packaging).
If you cannot find a clear product image, return {"x": 0, "y": 0, "w": 0, "h": 0}

Return ONLY the JSON object.`,
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 256,
        },
      }),
    }
  );

  if (!response.ok) {
    console.error('Gemini API error:', response.status, await response.text().catch(() => ''));
    return null;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text || '')
    .join('') || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const x = Number(parsed.x) || 0;
    const y = Number(parsed.y) || 0;
    const w = Number(parsed.w || parsed.width) || 0;
    const h = Number(parsed.h || parsed.height) || 0;

    if (w < 30 || h < 30) return null;

    return { x, y, w, h };
  } catch {
    return null;
  }
}
