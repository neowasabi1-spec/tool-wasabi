import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canAccessProject } from '@/lib/auth/project-access';
import { lastImageGenError, openaiGenerateImageBytes, openaiImageKey } from '@/lib/openai-image';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

const BUCKET = 'project-files';

/**
 * Prepare signed URLs + product context for remaking a competitor image,
 * generate via ChatGPT Images (gpt-image-2, not fal), or persist a result.
 *
 * POST { action: 'prepare' }
 * POST { action: 'generate', prompt, productImageUrl?, language?, mode? }
 * POST { action: 'save', url, prompt?, language?, mode? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; cid: string; adId: string } },
) {
  const { id, cid, adId } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const adIdNum = Number(adId);
  const brandIdNum = Number(cid);
  if (!Number.isFinite(adIdNum) || !Number.isFinite(brandIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    return uploadProductPhoto(req, id);
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body.action || 'prepare');

  if (action === 'save') return saveResult(id, brandIdNum, adIdNum, body);
  if (action === 'generate') return generateWithChatGpt(id, brandIdNum, adIdNum, body);

  const { data: ad } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, file_path, media_type, name, headline, hook, body_text')
    .eq('id', adIdNum)
    .eq('brand_id', brandIdNum)
    .eq('project_id', id)
    .maybeSingle();
  if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
  const a = ad as {
    file_path?: string; media_type?: string; name?: string;
    headline?: string; hook?: string; body_text?: string;
  };
  if (a.media_type === 'video' || !a.file_path) {
    return NextResponse.json({ error: 'This action is for still images' }, { status: 400 });
  }

  const imageUrl = await signedUrl(a.file_path);
  if (!imageUrl) {
    return NextResponse.json({ error: 'Could not sign the source image' }, { status: 500 });
  }

  const [productImageUrl, project] = await Promise.all([
    loadProductImage(id),
    loadProjectCtx(id),
  ]);
  const p = project;

  return NextResponse.json({
    imageUrl,
    productImageUrl,
    productName: String(p.name || '').trim(),
    brief: String(p.brief || p.description || '').slice(0, 4000),
    headline: a.headline || '',
    hook: a.hook || '',
    bodyText: a.body_text || '',
    name: a.name || '',
  });
}

async function generateWithChatGpt(
  projectId: string,
  brandId: number,
  adId: number,
  body: Record<string, unknown>,
) {
  try {
    if (!openaiImageKey()) {
      return NextResponse.json({ error: 'OPENAI_API_KEY is missing' }, { status: 500 });
    }
    const prompt = String(body.prompt || '').trim();
    if (prompt.length < 8) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
    }
    const { data: ad } = await supabaseAdmin
      .from('competitor_ads')
      .select('id, file_path, media_type')
      .eq('id', adId)
      .eq('brand_id', brandId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (!ad) return NextResponse.json({ error: 'Creative not found' }, { status: 404 });
    const a = ad as { file_path?: string; media_type?: string };
    if (a.media_type === 'video' || !a.file_path) {
      return NextResponse.json({ error: 'This action is for still images' }, { status: 400 });
    }
    const sourceUrl = await signedUrl(a.file_path);
    if (!sourceUrl) {
      return NextResponse.json({ error: 'Could not sign the source image' }, { status: 500 });
    }
    const productUrl = String(body.productImageUrl || '').trim();
    const imageUrls = [sourceUrl, /^https?:\/\//i.test(productUrl) ? productUrl : ''].filter(Boolean);
    const made = await openaiGenerateImageBytes({
      prompt,
      imageUrls,
      size: '1024x1536',
      quality: 'medium',
      timeoutMs: 120_000,
      openaiOnly: true,
    });
    if (!made) {
      return NextResponse.json(
        { error: lastImageGenError() || 'ChatGPT did not return an image' },
        { status: 502 },
      );
    }
    return persistBytes(projectId, brandId, adId, body, made);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || 'Image edit failed' },
      { status: 500 },
    );
  }
}

async function persistBytes(
  projectId: string,
  brandId: number,
  adId: number,
  body: Record<string, unknown>,
  made: { buf: Buffer; mime: string },
) {
  const mime = made.mime || 'image/png';
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const key = `${projectId}/generated/${adId}_img_${Date.now()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, made.buf, {
    contentType: mime,
    upsert: true,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const language = String(body.language || '').trim().slice(0, 40) || null;
  const prompt = String(body.prompt || body.mode || '').trim().slice(0, 2000);
  const row: Record<string, unknown> = {
    project_id: projectId,
    brand_id: brandId,
    ad_id: adId,
    file_path: key,
    thumb_path: key,
    duration_sec: 0,
    script: prompt || null,
    language,
  };
  let res = await supabaseAdmin.from('generated_videos').insert(row).select('id').maybeSingle();
  if (res.error && /language/i.test(res.error.message)) {
    delete row.language;
    res = await supabaseAdmin.from('generated_videos').insert(row).select('id').maybeSingle();
  }
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, video: res.data });
}

async function saveResult(
  projectId: string,
  brandId: number,
  adId: number,
  body: Record<string, unknown>,
) {
  const url = String(body.url || '').trim();
  const bytes = await bytesFromResult(url);
  if (!bytes) {
    return NextResponse.json({ error: 'Missing or unreadable result image' }, { status: 400 });
  }
  const { buf, mime } = bytes;
  const ext = /webp/i.test(mime) ? 'webp' : /jpe?g/i.test(mime) ? 'jpg' : 'png';
  const key = `${projectId}/generated/${adId}_img_${Date.now()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, buf, {
    contentType: mime || 'image/png',
    upsert: true,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const language = String(body.language || '').trim().slice(0, 40) || null;
  const prompt = String(body.prompt || body.mode || '').trim().slice(0, 2000);
  const row: Record<string, unknown> = {
    project_id: projectId,
    brand_id: brandId,
    ad_id: adId,
    file_path: key,
    thumb_path: key,
    duration_sec: 0,
    script: prompt || null,
    language,
  };
  let res = await supabaseAdmin.from('generated_videos').insert(row).select('*').maybeSingle();
  if (res.error && /language/i.test(res.error.message)) {
    delete row.language;
    res = await supabaseAdmin.from('generated_videos').insert(row).select('*').maybeSingle();
  }
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, video: res.data });
}

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

async function uploadProductPhoto(req: NextRequest, projectId: string) {
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: 'Expected a photo upload' }, { status: 400 });
  const file = fd.get('file');
  if (!(file instanceof File) || file.size <= 0) {
    return NextResponse.json({ error: 'Choose a product photo' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Photo must be 8 MB or smaller' }, { status: 400 });
  }
  const mime = (file.type || '').toLowerCase();
  if (mime && !ALLOWED.has(mime)) {
    return NextResponse.json({ error: 'Use a JPG, PNG or WebP photo' }, { status: 400 });
  }
  const ext = /webp/.test(mime) ? 'webp' : /png/.test(mime) ? 'png' : 'jpg';
  const safe = (file.name || 'product').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const key = `${projectId}/product_image/${Date.now()}_swipe_${safe}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, buf, {
    contentType: mime || 'image/jpeg',
    upsert: false,
  });
  if (upErr) return NextResponse.json({ error: upErr.message || 'Upload failed' }, { status: 500 });

  const { error: insErr } = await supabaseAdmin.from('project_files').insert({
    project_id: projectId,
    file_type: 'product_image',
    file_path: key,
    original_name: file.name || `product.${ext}`,
  });
  if (insErr) console.warn('[remake-image] project_files insert:', insErr.message);

  const url = await signedUrl(key);
  if (!url) return NextResponse.json({ error: 'Uploaded but could not sign the photo' }, { status: 500 });
  return NextResponse.json({ ok: true, productImageUrl: url, filePath: key });
}

async function loadProjectCtx(projectId: string): Promise<{ name?: string; brief?: string; description?: string }> {
  const full = await supabaseAdmin
    .from('projects')
    .select('name, brief, description')
    .eq('id', projectId)
    .maybeSingle();
  if (!full.error) return (full.data || {}) as { name?: string; brief?: string; description?: string };
  const slim = await supabaseAdmin
    .from('projects')
    .select('name, description')
    .eq('id', projectId)
    .maybeSingle();
  return (slim.data || {}) as { name?: string; description?: string };
}

async function bytesFromResult(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 80) return null;
      return { buf, mime: m[1] || 'image/png' };
    }
    if (!/^https?:\/\//i.test(url)) return null;
    const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!dl.ok) return null;
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length < 80) return null;
    const mime = (dl.headers.get('content-type') || 'image/png').split(';')[0].trim();
    return { buf, mime };
  } catch {
    return null;
  }
}

async function signedUrl(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadProductImage(projectId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return null;
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    return signedUrl(main.file_path);
  } catch {
    return null;
  }
}
