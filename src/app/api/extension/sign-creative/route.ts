import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';

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
 * POST /api/extension/sign-creative
 * Body: { projectId, contentType, mediaType?: 'image' | 'video' }
 *
 * Returns a Supabase signed upload URL so the extension can push a creative
 * (typically a large video the browser holds as a blob) STRAIGHT to storage,
 * bypassing the serverless ~6MB body limit that made /api/extension/save-creative
 * reject big videos with "too large". The extension then calls save-creative
 * with just the returned storage path.
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
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) {
    return NextResponse.json(
      { error: 'forbidden', message: 'You do not have access to this project.' },
      { status: 403 },
    );
  }

  const contentType = String(body.contentType || 'video/mp4');
  const ext = extForContentType(contentType);
  const path = `${projectId}/competitor-ads/uploads/${randomUUID()}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  // Build the absolute upload URL so the extension just PUTs the blob here.
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const uploadUrl = `${base}/storage/v1/object/upload/sign/${BUCKET}/${data.path}?token=${data.token}`;

  return NextResponse.json({ path: data.path, uploadUrl, contentType });
}
