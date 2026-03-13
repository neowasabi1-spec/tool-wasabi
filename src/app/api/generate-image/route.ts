import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const BUCKET_NAME = 'generated-images';

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
    const { prompt, size, style } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const validSize = (['1024x1024', '1792x1024', '1024x1792'] as const)
      .includes(size) ? size : '1024x1024';

    const validStyle = (style === 'natural' || style === 'vivid') ? style : 'vivid';

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: validSize,
      style: validStyle,
      response_format: 'b64_json',
    });

    const imageData = response.data?.[0];
    const b64 = imageData?.b64_json;
    const revisedPrompt = imageData?.revised_prompt;

    if (!b64) {
      return NextResponse.json({ error: 'No image generated' }, { status: 500 });
    }

    const sb = getSupabase();
    await ensureBucket(sb);

    const buffer = Buffer.from(b64, 'base64');
    const filename = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const filePath = `editor/${filename}`;

    const { error: uploadError } = await sb.storage
      .from(BUCKET_NAME)
      .upload(filePath, buffer, {
        contentType: 'image/png',
        upsert: false,
      });

    if (uploadError) {
      const dataUrl = `data:image/png;base64,${b64}`;
      return NextResponse.json({
        url: dataUrl,
        revisedPrompt,
        storage: 'inline',
      });
    }

    const { data: publicUrlData } = sb.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return NextResponse.json({
      url: publicUrlData.publicUrl,
      revisedPrompt,
      storage: 'supabase',
    });
  } catch (err: unknown) {
    console.error('Generate image error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
