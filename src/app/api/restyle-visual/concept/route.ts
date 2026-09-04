import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import { ingestLandingMediaBytes } from '@/lib/landing-media';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Create an illustration that matches nearby landing copy — no people. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    productName?: string;
    nearbyText?: string;
    prompt?: string;
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

  const prompt = asked || [
    `Landing-page image for ${productName}.`,
    nearby ? `Depict what this copy is about: "${nearby}".` : 'Depict the product idea, not a random stock scene.',
    'Commercial quality, no text in the image, no logos, no competitor brands.',
  ].filter(Boolean).join(' ');

  const made = await generatePng(prompt);
  if (!made) {
    return NextResponse.json({ error: 'Could not create illustration' }, { status: 502 });
  }

  const sourceUrl = `concept://generated/${slug(productName)}/${slug(asked || nearby).slice(0, 48) || 'slot'}`;
  const item = await ingestLandingMediaBytes(supabaseAdmin, {
    projectId,
    buf: made.buf,
    contentType: made.mime,
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

async function generatePng(prompt: string): Promise<{ buf: Buffer; mime: string } | null> {
  const gemini = await tryGemini(prompt);
  if (gemini) return gemini;
  return tryFal(prompt);
}

async function tryGemini(prompt: string): Promise<{ buf: Buffer; mime: string } | null> {
  const key = process.env.GEMINI_API_KEY || process.env.NETLIFY_AI_GATEWAY_KEY;
  const base = (process.env.GOOGLE_GEMINI_BASE_URL || process.env.NETLIFY_AI_GATEWAY_BASE_URL || '')
    .replace(/\/$/, '');
  if (!key || !base) return null;
  try {
    const url = `${base}/v1beta/models/gemini-2.5-flash-image:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) return null;
    const mime = part.inlineData.mimeType || 'image/png';
    return { buf: Buffer.from(part.inlineData.data, 'base64'), mime };
  } catch {
    return null;
  }
}

async function tryFal(prompt: string): Promise<{ buf: Buffer; mime: string } | null> {
  const key = process.env.FAL_KEY || process.env.FAL_AI_API_KEY;
  if (!key) return null;
  try {
    const submit = await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Key ${key}` },
      body: JSON.stringify({
        prompt,
        image_size: { width: 1024, height: 768 },
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!submit.ok) return null;
    const job = (await submit.json()) as { status_url?: string; response_url?: string };
    if (!job.status_url || !job.response_url) return null;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const st = await fetch(job.status_url, {
        headers: { authorization: `Key ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!st.ok) continue;
      const status = (await st.json()) as { status?: string };
      if (status.status === 'ERROR') return null;
      if (status.status !== 'COMPLETED') continue;
      const done = await fetch(job.response_url, {
        headers: { authorization: `Key ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      if (!done.ok) return null;
      const result = (await done.json()) as { images?: Array<{ url?: string }> };
      const imageUrl = result.images?.[0]?.url;
      if (!imageUrl) return null;
      const bin = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
      if (!bin.ok) return null;
      const mime = bin.headers.get('content-type') || 'image/png';
      return { buf: Buffer.from(await bin.arrayBuffer()), mime };
    }
  } catch {
    return null;
  }
  return null;
}
