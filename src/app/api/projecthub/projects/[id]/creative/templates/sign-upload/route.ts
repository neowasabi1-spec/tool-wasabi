import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { extForContentType, mediaTypeForContentType } from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/projecthub/projects/:id/creative/templates/sign-upload
 * Body: { filename, contentType }
 * Signed upload URL so images/videos for the Creatives tab go straight to
 * storage (bypasses the ~6MB serverless request body limit).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const contentType = String(body.contentType || 'application/octet-stream');
  if (!/^(image|video)\//i.test(contentType)) {
    return NextResponse.json({ error: 'Only images and videos can be uploaded' }, { status: 400 });
  }

  const ext = extForContentType(contentType, /^video\//i.test(contentType) ? 'mp4' : 'jpg');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${id}/creatives/${Date.now()}_${rand}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from('project-files').createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  return NextResponse.json({ path: data.path, token: data.token, media_type: mediaTypeForContentType(contentType) });
}
