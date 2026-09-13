import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { ingestLandingMediaBytes } from '@/lib/landing-media';
import { openaiGenerateImage } from '@/lib/openai-image';
import { loadStepOffer } from '@/lib/step-offer';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Landing illustration via ChatGPT Images. When the user uploaded a mockup,
 * that photo is the only allowed product — never Gemini/Flux inventing a
 * yellow/purple/red SKU from the product name.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    productName?: string;
    nearbyText?: string;
    prompt?: string;
    productImageUrl?: string;
    extraImageUrls?: string[];
    pageType?: string;
    pageName?: string;
  };
  const projectId = String(body.projectId || '').trim();
  const productName = String(body.productName || '').trim();
  const nearby = String(body.nearbyText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const asked = String(body.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!projectId || !productName) {
    return NextResponse.json({ error: 'projectId and productName required' }, { status: 400 });
  }
  const { allowed } = await canAccessProject(req, projectId);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const refs = await resolveMockupUrls(projectId, body);

  const prompt = [
    asked || [
      `Landing-page image for ${productName}.`,
      nearby ? `Depict what this copy is about: "${nearby}".` : 'Depict the situation the copy describes.',
    ].filter(Boolean).join(' '),
    refs.length
      ? [
          'Image 1 is the user-uploaded product mockup — the ONLY allowed product in this photo.',
          'Keep that exact pack: same shape, colors, label artwork, branding and silhouette.',
          'If Image 1 is a dark-green/gold box, every product in the frame stays that green/gold pack.',
          'Never invent another SKU or colorway (no yellow, orange, purple, pink, red, grape, mango, or cartoon mascot pack) unless Image 1 actually looks like that.',
          `The product name "${productName}" may be leftover competitor copy — ignore typical colors for that name. The mockup photo wins.`,
          'Lifestyle/setting/people may change. If the scene does not need the product, do not add a different product.',
        ].join(' ')
      : 'Do not invent a retail pack, box, sachet or stick unless the copy is literally selling the product. No competitor brands.',
    'Commercial quality, little or no extra text in the image.',
  ].filter(Boolean).join(' ');

  const made = await openaiGenerateImage({
    prompt,
    imageUrls: refs.length ? refs : undefined,
    size: '1536x1024',
    quality: 'medium',
    timeoutMs: 90_000,
    openaiOnly: true,
  });
  if (!made) {
    return NextResponse.json({ error: 'Could not create illustration' }, { status: 502 });
  }

  const bytes = await bytesFromImageUrl(made);
  if (!bytes) {
    return NextResponse.json({ error: 'Could not read generated image' }, { status: 502 });
  }

  const sourceUrl = `concept://generated/${slug(productName)}/${slug(asked || nearby).slice(0, 48) || 'slot'}`;
  const item = await ingestLandingMediaBytes(supabaseAdmin, {
    projectId,
    buf: bytes.buf,
    contentType: bytes.mime,
    sourceUrl,
    kind: 'image',
    section: 'mechanism',
  });
  if (!item?.storedUrl) {
    return NextResponse.json({ error: 'Could not store illustration' }, { status: 500 });
  }
  return NextResponse.json({ url: item.storedUrl, id: item.id });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function httpUrls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const u of list) {
    const t = String(u || '').trim();
    if (/^https?:\/\//i.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

async function resolveMockupUrls(
  projectId: string,
  body: { productImageUrl?: string; extraImageUrls?: string[]; pageType?: string; pageName?: string },
): Promise<string[]> {
  const refs = httpUrls([body.productImageUrl, ...(body.extraImageUrls || [])]).slice(0, 4);
  if (refs.length) return refs;
  try {
    const offer = await loadStepOffer(
      supabaseAdmin,
      projectId,
      String(body.pageType || 'landing'),
      String(body.pageName || ''),
    );
    return offer.imageUrls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 4);
  } catch {
    return [];
  }
}

async function bytesFromImageUrl(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 80) return null;
      return { buf, mime: m[1] || 'image/png' };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 80) return null;
    const mime = (res.headers.get('content-type') || 'image/png').split(';')[0];
    return { buf, mime };
  } catch {
    return null;
  }
}
