import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import { canAccessProject } from '@/lib/auth/project-access';
import { lastImageGenError, openaiImageKey, pollGptImage2Job, submitGptImage2Job } from '@/lib/openai-image';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

const BUCKET = 'project-files';
const ANALYZE_PROMPT = `Analyze this advertisement still. Return ONLY JSON (no markdown) with:
{
  "layout": "short description of composition (split, overlay, UGC, before/after, product hero, etc.)",
  "productPlacement": "where the product sits and how large it is",
  "subjects": "people, setting, props",
  "colors": "palette and mood",
  "lighting": "lighting style",
  "texts": [{"role":"headline|sub|badge|cta|caption|legal","text":"..."}],
  "techniques": ["before/after","scarcity","authority", "..."],
  "notes": "anything else needed to rebuild the same structure"
}`;

type SourceAd = {
  id: string;
  name: string;
  ad_type: string;
  category: string;
  media_type: string;
  file_path: string;
};

async function signedUrl(path: string): Promise<string | null> {
  if (/^https?:\/\//i.test(path)) return path;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function analyzeLayout(imageUrl: string): Promise<string> {
  const key = openaiImageKey();
  if (!key) return '';
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 900,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: ANALYZE_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.warn('[ads/recreate] vision', res.status, (await res.text()).slice(0, 240));
    return '';
  }
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return String(json.choices?.[0]?.message?.content || '').trim();
}

async function loadProjectCtx(projectId: string) {
  let name = '';
  let brief = '';
  const full = await supabaseAdmin
    .from('projects')
    .select('name, brief, description')
    .eq('id', projectId)
    .maybeSingle();
  if (!full.error) {
    const p = (full.data || {}) as { name?: string; brief?: string; description?: string };
    name = String(p.name || '').trim();
    brief = String(p.brief || p.description || '').trim();
  } else {
    const slim = await supabaseAdmin
      .from('projects')
      .select('name, description')
      .eq('id', projectId)
      .maybeSingle();
    const p = (slim.data || {}) as { name?: string; description?: string };
    name = String(p.name || '').trim();
    brief = String(p.description || '').trim();
  }

  const { data: files } = await supabaseAdmin
    .from('project_files')
    .select('file_path, original_name, created_at')
    .eq('project_id', projectId)
    .eq('file_type', 'product_image')
    .order('created_at', { ascending: false })
    .limit(20);
  const rows = (files || []) as Array<{ file_path: string; original_name?: string | null }>;
  const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
  const productImageUrl = main?.file_path ? await signedUrl(main.file_path) : null;
  return {
    name,
    brief: brief.slice(0, 3500),
    productImageUrl,
  };
}

async function loadCatalogProduct(productId: string) {
  const { data } = await supabaseAdmin
    .from('products')
    .select('id, name, description, brand_name, benefits, image_url, cta_text')
    .eq('id', productId)
    .maybeSingle();
  if (!data) return null;
  const p = data as {
    name?: string; description?: string; brand_name?: string;
    benefits?: string[]; image_url?: string | null; cta_text?: string;
  };
  const benefits = Array.isArray(p.benefits) ? p.benefits.filter(Boolean).slice(0, 8).join('; ') : '';
  return {
    name: String(p.name || '').trim(),
    brief: [p.brand_name, p.description, benefits, p.cta_text].filter(Boolean).join('\n').slice(0, 3500),
    productImageUrl: p.image_url && /^https?:\/\//i.test(p.image_url) ? p.image_url : null,
  };
}

function layoutOnlyAnalysis(raw: string): string {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    return JSON.stringify({
      layout: json.layout,
      productPlacement: json.productPlacement,
      subjects: json.subjects,
      colors: json.colors,
      lighting: json.lighting,
      techniques: json.techniques,
      notes: json.notes,
    });
  } catch {
    return cleaned.slice(0, 800);
  }
}

function buildPrompt(opts: {
  productName: string;
  brief: string;
  analysis: string;
  hasPackshot: boolean;
}): string {
  const name = opts.productName || 'our product';
  const layout = opts.analysis ? layoutOnlyAnalysis(opts.analysis) : '';
  return [
    opts.hasPackshot
      ? 'Image 1 is the LAYOUT to keep. Image 2 is our exact packshot — use that product, do not invent a bottle.'
      : 'The attached image is the LAYOUT to keep.',
    `Create a brand-new lifestyle advertisement for ${name}.`,
    'Keep the same composition: panels, product placement, hierarchy, lighting and color rhythm.',
    'Rewrite every on-image word for our product. Do not copy competitor brands, logos, disease names, lesions, or medical claims.',
    'Wellness / cosmetic commercial still only. No medical before/after of infections or conditions.',
    opts.brief ? `Our product:\n${opts.brief.slice(0, 1200)}` : '',
    layout ? `Layout notes (structure only):\n${layout}` : '',
    'Photorealistic, sharp typography, no watermarks.',
  ].filter(Boolean).join('\n\n');
}

async function saveToProjectCreatives(
  req: NextRequest,
  userId: string,
  body: Record<string, unknown>,
) {
  const projectId = String(body.projectId || '').trim();
  const filePath = String(body.filePath || '').trim();
  const name = String(body.name || 'Recreated ad').trim().slice(0, 300) || 'Recreated ad';
  if (!projectId) {
    return NextResponse.json({ error: 'Pick a project to save into Creative' }, { status: 400 });
  }
  if (!filePath) {
    return NextResponse.json({ error: 'Missing generated image' }, { status: 400 });
  }
  const allowedPrefix = `archive-ads/${userId}/`;
  if (!filePath.startsWith(allowedPrefix)) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
  }
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(BUCKET).download(filePath);
  if (dlErr || !blob) {
    return NextResponse.json({ error: dlErr?.message || 'Could not read generated image' }, { status: 500 });
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const ext = (filePath.split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const dest = `${projectId}/creatives/recreate_${Date.now()}.${ext}`;
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(dest, buf, {
    contentType: mime,
    upsert: false,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data: created, error: insErr } = await supabaseAdmin
    .from('creative_templates')
    .insert({
      project_id: projectId,
      name,
      source_brand: '',
      category: 'Recreated ads',
      file_path: dest,
      media_type: 'image',
      tags: '',
    })
    .select()
    .single();
  if (insErr || !created) {
    return NextResponse.json(
      { error: insErr?.message || 'Copied file but could not add it to Creative' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, creative: created, filePath: dest });
}

async function finishRecreateJob(userId: string, body: Record<string, unknown>) {
  const statusUrl = String(body.statusUrl || '').trim();
  const responseUrl = String(body.responseUrl || '').trim();
  const name = String(body.name || 'Recreated ad').trim().slice(0, 300) || 'Recreated ad';
  if (!statusUrl || !responseUrl) {
    return NextResponse.json({ error: 'Missing ChatGPT Image 2 job' }, { status: 400 });
  }
  const polled = await pollGptImage2Job({ statusUrl, responseUrl });
  if (polled.status === 'pending') {
    return NextResponse.json({
      status: 'pending',
      falStatus: polled.falStatus || 'IN_QUEUE',
      statusUrl,
      responseUrl,
      name,
    });
  }
  if (polled.status === 'error') {
    return NextResponse.json({ status: 'error', error: polled.error }, { status: 502 });
  }

  const ext = /webp/i.test(polled.mime) ? 'webp' : /jpe?g/i.test(polled.mime) ? 'jpg' : 'png';
  const outPath = `archive-ads/${userId}/drafts/recreate_${Date.now()}.${ext}`;
  const { error: saveErr } = await supabaseAdmin.storage.from(BUCKET).upload(outPath, polled.buf, {
    contentType: polled.mime,
    upsert: false,
  });
  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 });
  const previewUrl = await signedUrl(outPath);
  return NextResponse.json({
    ok: true,
    status: 'completed',
    filePath: outPath,
    name,
    previewUrl,
  });
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data, error } = await supabaseAdmin
    .from('products')
    .select('id, name, brand_name, image_url')
    .order('name', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ products: [] });
  return NextResponse.json({ products: data || [] });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const ct = req.headers.get('content-type') || '';
    let jsonBody: Record<string, unknown> | null = null;
    if (!ct.includes('multipart/form-data')) {
      jsonBody = await req.json().catch(() => ({} as Record<string, unknown>));
      if (String(jsonBody.action || '') === 'save') {
        return saveToProjectCreatives(req, userId, jsonBody);
      }
      if (String(jsonBody.action || '') === 'poll') {
        return finishRecreateJob(userId, jsonBody);
      }
    }

    const { data: ad } = await supabaseAdmin
      .from('archive_ads')
      .select('id, name, ad_type, category, media_type, file_path')
      .eq('id', params.id)
      .maybeSingle();
    if (!ad) return NextResponse.json({ error: 'Ad not found' }, { status: 404 });
    const source = ad as SourceAd;
    if (source.media_type === 'video' || source.media_type === 'folder' || !source.file_path) {
      return NextResponse.json({ error: 'Recreate is available for still images only' }, { status: 400 });
    }

    let projectId = '';
    let productId = '';
    let productNameHint = '';
    let uploadedProduct: { buf: Buffer; mime: string } | null = null;

    if (ct.includes('multipart/form-data')) {
      const fd = await req.formData().catch(() => null);
      if (!fd) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 });
      projectId = String(fd.get('projectId') || '').trim();
      productId = String(fd.get('productId') || '').trim();
      productNameHint = String(fd.get('productName') || '').trim();
      const file = fd.get('file');
      if (file instanceof File && file.size > 0) {
        if (file.size > 8 * 1024 * 1024) {
          return NextResponse.json({ error: 'Product photo must be 8 MB or smaller' }, { status: 400 });
        }
        const mime = (file.type || 'image/jpeg').split(';')[0].toLowerCase();
        if (mime && !/^image\/(jpeg|jpg|png|webp)$/.test(mime)) {
          return NextResponse.json({ error: 'Use a JPG, PNG or WebP product photo' }, { status: 400 });
        }
        uploadedProduct = {
          buf: Buffer.from(await file.arrayBuffer()),
          mime: mime || 'image/jpeg',
        };
      }
    } else {
      projectId = String(jsonBody?.projectId || '').trim();
      productId = String(jsonBody?.productId || '').trim();
      productNameHint = String(jsonBody?.productName || '').trim();
    }

    if (projectId) {
      const { allowed } = await canAccessProject(req, projectId);
      if (!allowed) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const sourceUrl = await signedUrl(source.file_path);
    if (!sourceUrl) {
      return NextResponse.json({ error: 'Could not sign the source ad image' }, { status: 500 });
    }

    let productName = productNameHint;
    let brief = '';
    let productImageUrl: string | null = null;

    if (projectId) {
      const ctx = await loadProjectCtx(projectId);
      productName = productName || ctx.name;
      brief = ctx.brief;
      productImageUrl = ctx.productImageUrl;
    }
    if (productId) {
      const cat = await loadCatalogProduct(productId);
      if (cat) {
        productName = productName || cat.name;
        brief = [brief, cat.brief].filter(Boolean).join('\n');
        productImageUrl = productImageUrl || cat.productImageUrl;
      }
    }

    if (uploadedProduct) {
      const ext = /png/i.test(uploadedProduct.mime) ? 'png' : /webp/i.test(uploadedProduct.mime) ? 'webp' : 'jpg';
      const key = `archive-ads/${userId}/product_${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, uploadedProduct.buf, {
        contentType: uploadedProduct.mime,
        upsert: false,
      });
      if (upErr) return NextResponse.json({ error: `Product photo upload failed: ${upErr.message}` }, { status: 500 });
      productImageUrl = await signedUrl(key);
    }

    if (!productName && !productImageUrl && !brief) {
      return NextResponse.json(
        { error: 'Pick a project, a catalog product, or upload a product photo.' },
        { status: 400 },
      );
    }

    let analysis = '';
    try {
      analysis = await analyzeLayout(sourceUrl);
    } catch (e) {
      console.warn('[ads/recreate] analysis failed:', (e as Error).message);
    }

    const prompt = buildPrompt({
      productName: productName || 'our product',
      brief,
      analysis,
      hasPackshot: Boolean(productImageUrl),
    });

    const imageUrls = [sourceUrl, productImageUrl || ''].filter(Boolean);
    const job = await submitGptImage2Job({
      prompt,
      imageUrls,
      size: 'auto',
      quality: 'medium',
    });
    if (!job) {
      return NextResponse.json(
        { error: lastImageGenError() || 'Could not start ChatGPT Image 2' },
        { status: 502 },
      );
    }

    const name = `${productName || 'Swipe'} — ${source.name}`.slice(0, 300);
    return NextResponse.json({
      ok: true,
      status: 'pending',
      analysis,
      name,
      projectId: projectId || null,
      statusUrl: job.statusUrl,
      responseUrl: job.responseUrl,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || 'Recreate failed' },
      { status: 500 },
    );
  }
}
