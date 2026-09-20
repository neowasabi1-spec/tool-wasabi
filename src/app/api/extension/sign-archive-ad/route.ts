import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = 'project-files';

function extForContentType(ct: string): string {
  const c = ct.toLowerCase();
  if (c.includes('webm')) return 'webm';
  if (c.includes('quicktime') || c.includes('mov')) return 'mov';
  if (c.includes('png')) return 'png';
  if (c.includes('webp')) return 'webp';
  if (c.includes('gif')) return 'gif';
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg';
  if (c.startsWith('video/')) return 'mp4';
  return 'bin';
}

/**
 * Signed upload into Template → Ads storage so the extension can PUT a large
 * video without hitting the ~6MB serverless body limit.
 */
export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Connect the extension to your account first.' },
      { status: 401 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const contentType = String(body.contentType || 'video/mp4');
  const ext = extForContentType(contentType);
  const path = `archive-ads/${userId}/${randomUUID()}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const uploadUrl = `${base}/storage/v1/object/upload/sign/${BUCKET}/${data.path}?token=${data.token}`;

  return NextResponse.json({ path: data.path, uploadUrl, contentType });
}
