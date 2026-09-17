import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { extForContentType, mediaTypeForContentType } from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Signed upload for Template → Ads (bypasses the ~6MB serverless body limit).
 * Body: { filename, contentType }
 */
export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const contentType = String(body.contentType || 'application/octet-stream');
  if (!/^(image|video)\//i.test(contentType)) {
    return NextResponse.json({ error: 'Only images and videos can be uploaded' }, { status: 400 });
  }

  const ext = extForContentType(contentType, /^video\//i.test(contentType) ? 'mp4' : 'jpg');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `archive-ads/${userId}/${Date.now()}_${rand}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from('project-files').createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  return NextResponse.json({
    path: data.path,
    token: data.token,
    media_type: mediaTypeForContentType(contentType),
  });
}
