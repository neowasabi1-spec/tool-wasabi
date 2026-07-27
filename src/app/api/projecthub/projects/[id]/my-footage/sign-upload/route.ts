import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { ensureBrand, extForContentType } from '@/lib/competitor-ads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OWN_BRAND = 'My Footage';

/**
 * POST /api/projecthub/projects/:id/my-footage/sign-upload
 * Body: { filename, contentType }
 * Returns a Supabase signed upload URL so the browser can push large videos
 * straight to storage (bypassing the 6MB serverless body limit), plus the
 * brand id the resulting creative should be registered under.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const filename = String(body.filename || 'video.mp4');
  const contentType = String(body.contentType || 'video/mp4');
  if (!/^video\//i.test(contentType)) {
    return NextResponse.json({ error: 'Only video files are supported here' }, { status: 400 });
  }

  const brandId = await ensureBrand(id, OWN_BRAND, '');
  if (!brandId) return NextResponse.json({ error: 'Could not prepare folder' }, { status: 500 });

  const ext = extForContentType(contentType, 'mp4');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${id}/my-footage/${brandId}/${Date.now()}_${rand}.${ext}`;

  const { data, error } = await supabaseAdmin.storage.from('project-files').createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Could not sign upload' }, { status: 500 });
  }

  return NextResponse.json({ path: data.path, token: data.token, brandId });
}
