import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/extension/sign-shot
 * Body: { variant: 'desktop' | 'mobile', contentType?: string }
 *
 * Returns a Supabase signed upload URL so the extension can push a full-page
 * screenshot STRAIGHT to storage. Full-page PNGs (base64-inflated) routinely
 * blew past the 6MB serverless body limit and made /api/extension/save-page
 * reject the whole save with a 413 — so the heavy bytes now bypass the function
 * entirely and only the resulting storage path is sent to save-page.
 *
 * Auth: per-user Supabase access token (Authorization: Bearer <token>).
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
  const variant = body.variant === 'mobile' ? 'mobile' : 'desktop';
  const contentType = String(body.contentType || 'image/png');
  if (!/^image\//i.test(contentType)) {
    return NextResponse.json({ error: 'Only image screenshots are supported' }, { status: 400 });
  }
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const path = `extension-captures/uploads/${userId}/${randomUUID()}/${variant}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from('media').createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  // Build the absolute upload URL ourselves so the extension needs no Supabase
  // SDK or project URL — it just PUTs the blob here.
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const uploadUrl = `${base}/storage/v1/object/upload/sign/media/${data.path}?token=${data.token}`;

  return NextResponse.json({ path: data.path, uploadUrl, contentType });
}
