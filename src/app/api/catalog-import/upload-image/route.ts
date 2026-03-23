import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 30;
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
    const { base64, mimeType, filename } = await req.json();

    if (!base64) {
      return NextResponse.json({ error: 'base64 image data is required' }, { status: 400 });
    }

    const sb = getSupabase();
    await ensureBucket(sb);

    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType?.includes('png') ? 'png' : 'jpg';
    const safeName = (filename || 'product').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const filePath = `catalog/${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;

    const { error: uploadError } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, {
        contentType: mimeType || 'image/jpeg',
        upsert: false,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return NextResponse.json({ error: 'Upload failed: ' + uploadError.message }, { status: 500 });
    }

    const { data: publicUrlData } = sb.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return NextResponse.json({ imageUrl: publicUrlData.publicUrl });
  } catch (err) {
    console.error('Catalog image upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
