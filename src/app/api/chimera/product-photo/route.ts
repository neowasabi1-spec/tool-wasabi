import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getUserAccessContext } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = 'project-files';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

async function ensureBucket(): Promise<void> {
  try {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 52428800,
    });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn('[chimera photo] ensureBucket:', error.message);
    }
  } catch (e) {
    console.warn('[chimera photo] ensureBucket threw:', (e as Error).message);
  }
}

/**
 * POST /api/chimera/product-photo
 * FormData: file (required), projectId? (optional)
 * Returns { url } — a public packshot URL Chimera can reuse for colors + product shots.
 */
export async function POST(req: NextRequest) {
  const ctx = await getUserAccessContext(req);
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 });

  const file = fd.get('file');
  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'Choose a product photo.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Photo must be 8 MB or smaller.' }, { status: 400 });
  }
  const mime = (file.type || '').toLowerCase();
  if (mime && !ALLOWED.has(mime)) {
    return NextResponse.json({ error: 'Use a JPG, PNG or WebP photo.' }, { status: 400 });
  }

  const projectId = String(fd.get('projectId') || '').trim();
  if (projectId) {
    const { allowed } = await canAccessProject(req, projectId);
    if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await ensureBucket();

  const ext = /webp/.test(mime) ? 'webp' : /png/.test(mime) ? 'png' : 'jpg';
  const safe = (file.name || 'product').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const objectKey = projectId
    ? `${projectId}/product_image/${Date.now()}_Chimera_Protocol_Product_uploaded_${safe}.${ext}`
    : `chimera-uploads/${Date.now()}_${safe}.${ext}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const contentType = mime || 'image/jpeg';
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(objectKey, buf, { contentType, upsert: false });
  if (upErr) {
    return NextResponse.json({ error: upErr.message || 'Upload failed' }, { status: 500 });
  }

  if (projectId) {
    const row: Record<string, unknown> = {
      project_id: projectId,
      file_type: 'product_image',
      file_path: objectKey,
      original_name: `Chimera Protocol — Product — uploaded.${ext}`,
    };
    if (ctx.userId) row.owner_user_id = ctx.userId;
    const { error: insErr } = await supabaseAdmin.from('project_files').insert(row);
    if (insErr) {
      await supabaseAdmin.storage.from(BUCKET).remove([objectKey]).catch(() => {});
      return NextResponse.json({ error: insErr.message || 'Could not save photo' }, { status: 500 });
    }
  }

  const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(objectKey);
  const url = pub?.publicUrl || '';
  if (!url) return NextResponse.json({ error: 'Upload saved but public URL missing' }, { status: 500 });
  return NextResponse.json({ url });
}
