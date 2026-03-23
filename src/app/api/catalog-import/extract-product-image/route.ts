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
    const body = await req.json();
    const { productName, pageImageUrl, pageBase64 } = body;

    if (!productName) {
      return NextResponse.json({ error: 'productName is required' }, { status: 400 });
    }

    const geminiKey = (
      (process.env.GEMINI_API_KEY ?? '') ||
      (process.env.GOOGLE_GEMINI_API_KEY ?? '')
    ).trim();

    if (!geminiKey) {
      return NextResponse.json({ error: 'GOOGLE_GEMINI_API_KEY not configured' }, { status: 500 });
    }

    let imageBuffer: Buffer;
    let base64ForGemini: string;

    if (pageBase64) {
      imageBuffer = Buffer.from(pageBase64, 'base64');
      base64ForGemini = pageBase64;
    } else if (pageImageUrl) {
      const res = await fetch(pageImageUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.error('Failed to download page image:', res.status);
        return NextResponse.json({ imageUrl: '' });
      }
      imageBuffer = Buffer.from(await res.arrayBuffer());
      base64ForGemini = imageBuffer.toString('base64');
    } else {
      return NextResponse.json({ error: 'pageImageUrl or pageBase64 is required' }, { status: 400 });
    }

    const compressedBuffer = await sharp(imageBuffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    const compressedBase64 = compressedBuffer.toString('base64');

    const bbox = await getProductImageBBox(geminiKey, compressedBase64, productName);

    if (!bbox) {
      console.log(`No product image found for "${productName}"`);
      return NextResponse.json({ imageUrl: '' });
    }

    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 1000;
    const imgHeight = metadata.height || 1000;

    const left = Math.max(0, Math.round((bbox.x / 1000) * imgWidth));
    const top = Math.max(0, Math.round((bbox.y / 1000) * imgHeight));
    const width = Math.min(imgWidth - left, Math.round((bbox.w / 1000) * imgWidth));
    const height = Math.min(imgHeight - top, Math.round((bbox.h / 1000) * imgHeight));

    if (width < 20 || height < 20) {
      return NextResponse.json({ imageUrl: '' });
    }

    console.log(`Cropping "${productName}": left=${left}, top=${top}, w=${width}, h=${height} from ${imgWidth}x${imgHeight}`);

    const croppedBuffer = await sharp(imageBuffer)
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
    console.log(`Extracted image for "${productName}": ${data.publicUrl}`);
    return NextResponse.json({ imageUrl: data.publicUrl });
  } catch (err) {
    console.error('Extract product image error:', err);
    return NextResponse.json({ imageUrl: '' });
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
              text: `This is a supplement/product catalog page. I need to crop ONLY the product bottle/packaging/container image for "${productName}".

CRITICAL RULES:
- Find the WHITE BOTTLE or PRODUCT CONTAINER/PACKAGING for "${productName}" specifically
- Crop TIGHT around JUST the bottle/jar/box — nothing else
- Do NOT include ingredient tables, text descriptions, pricing, lifestyle photos, or other products
- The bottle is usually on the LEFT side of the product section
- If the page shows multiple products, find the one labeled "${productName}" and crop ONLY its bottle
- The bounding box should cover roughly 15-30% of the page width and 20-40% of the page height — just the bottle

Return bounding box as JSON on 0-1000 scale (0,0 = top-left corner, 1000,1000 = bottom-right corner):
{"x": <left>, "y": <top>, "w": <width>, "h": <height>}

The width should typically be 150-300 and height 200-400 (just the bottle, not the whole row).

If you cannot find a distinct product bottle/container, return: {"x": 0, "y": 0, "w": 0, "h": 0}

Return ONLY the JSON.`,
            },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 200,
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('Gemini Vision API error:', response.status, errText.substring(0, 200));
    return null;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text || '')
    .join('') || '';

  console.log(`Gemini bbox response for "${productName}":`, text);

  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const x = Number(parsed.x) || 0;
    const y = Number(parsed.y) || 0;
    const w = Number(parsed.w || parsed.width) || 0;
    const h = Number(parsed.h || parsed.height) || 0;

    if (w < 30 || h < 30) return null;

    if (w > 600 || h > 700) {
      console.log(`BBox too large for "${productName}": w=${w}, h=${h} — clamping`);
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      const clampedW = Math.min(w, 350);
      const clampedH = Math.min(h, 450);
      return {
        x: Math.max(0, centerX - clampedW / 2),
        y: Math.max(0, centerY - clampedH / 2),
        w: clampedW,
        h: clampedH,
      };
    }

    return { x, y, w, h };
  } catch {
    return null;
  }
}
