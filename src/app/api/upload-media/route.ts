import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

const MIME_MAP: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'video/quicktime': 'mov',
};

export async function POST(request: NextRequest) {
  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` }, { status: 400 });
    }

    const ext = MIME_MAP[file.type];
    if (!ext) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: ${Object.keys(MIME_MAP).join(', ')}` },
        { status: 400 },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
    const storagePath = `editor-uploads/${timestamp}_${safeName}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from('media')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      if (uploadError.message?.includes('Bucket not found')) {
        return NextResponse.json(
          { error: 'Storage bucket "media" not found. Create it in Supabase Dashboard → Storage.' },
          { status: 500 },
        );
      }
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: publicData } = supabase.storage
      .from('media')
      .getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      url: publicData.publicUrl,
      name: file.name,
      size: file.size,
      type: file.type,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 },
    );
  }
}
