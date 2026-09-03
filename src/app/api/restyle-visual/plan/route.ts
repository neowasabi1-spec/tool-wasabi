import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';
import { SWIPE_MODEL_DEFAULT } from '@/lib/swipe-models';
import { collectRestyleSlots, type RestyleSlot } from '@/lib/restyle-slots';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROJECT_FILES_BUCKET = 'project-files';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    html?: string;
    slots?: RestyleSlot[];
    productName?: string;
    brief?: string;
    research?: string;
    description?: string;
    projectId?: string;
  };
  const productName = String(body.productName || '').trim();
  if (!productName) {
    return NextResponse.json({ error: 'productName required' }, { status: 400 });
  }

  const slots = Array.isArray(body.slots) && body.slots.length
    ? body.slots.slice(0, 20)
    : collectRestyleSlots(String(body.html || ''), 20);
  if (!slots.length) {
    return NextResponse.json({ error: 'No photos/GIFs/videos found on the page' }, { status: 400 });
  }

  const productImageUrl = body.projectId ? await loadProductImage(body.projectId) : null;
  const brief = String(body.brief || '').slice(0, 12_000);
  const research = String(body.research || '').slice(0, 8_000);
  const description = String(body.description || '').slice(0, 4_000);

  const system = `You are a creative director restyling a competitor landing into a new brand world — same job ChatGPT does in one pass.

PRODUCT: ${productName}
${description ? `DESCRIPTION:\n${description}\n` : ''}
${brief ? `BRIEF (source of truth):\n${brief}\n` : ''}
${research ? `MARKET RESEARCH:\n${research}\n` : ''}

Return STRICT JSON only:
{
  "primary":"#hex","secondary":"#hex","accent":"#hex","background":"#hex","ink":"#hex",
  "world":"one sentence visual world (light, materials, mood)",
  "avatar":"one consistent person for every lifestyle shot",
  "slots":[{"id":0,"kind":"image|gif|video","role":"hero|product|lifestyle|...","prompt":"...","aspect":"16:9|1:1|4:3|9:16"}]
}

Rules:
- One object per input id. Every prompt MUST be unique (different crop, angle, moment). Never reuse a composition.
- Same world + same avatar on every lifestyle frame.
- Product packshots describe OUR product (${productName}), not the competitor.
- Prompt is a full image-generation brief (scene, lighting, lens). No HTML. No competitor brand names.
- GIFs: describe a still that can replace the animation (peak moment).
- Videos: describe the key cinematic still (we animate it after).`;

  const user = `Plan the new visual world and a unique prompt for every slot.\n${JSON.stringify(
    slots.map((s) => ({
      id: s.id,
      kind: s.kind,
      alt: s.alt,
      section: s.section,
      size: s.width && s.height ? `${s.width}x${s.height}` : 'unknown',
    })),
    null,
    2,
  )}`;

  const raw = await callClaude(system, user);
  const plan = parsePlan(raw, slots);

  return NextResponse.json({
    ok: true,
    productImageUrl,
    palette: {
      primary: plan.primary,
      secondary: plan.secondary,
      accent: plan.accent,
      background: plan.background,
      ink: plan.ink,
      world: plan.world,
      avatar: plan.avatar,
    },
    slots: slots.map((s) => {
      const p = plan.slots.find((x) => x.id === s.id);
      return {
        ...s,
        role: p?.role || s.section,
        prompt: p?.prompt || defaultPrompt(s, productName, plan.world),
        aspect: p?.aspect || aspectOf(s),
      };
    }),
  });
}

function defaultPrompt(s: RestyleSlot, product: string, world: string): string {
  return `Unique ${s.kind} for ${product}, ${s.section} section. ${world || 'premium commercial light'}. Alt: ${s.alt || 'none'}. No competitor brands.`;
}

function aspectOf(s: RestyleSlot): string {
  if (s.kind === 'video') return '16:9';
  if (s.width && s.height) {
    const r = s.width / s.height;
    if (r > 1.4) return '16:9';
    if (r < 0.75) return '9:16';
  }
  return '4:3';
}

function parsePlan(raw: string, slots: RestyleSlot[]) {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  const j = JSON.parse(c) as {
    primary?: string; secondary?: string; accent?: string; background?: string; ink?: string;
    world?: string; avatar?: string;
    slots?: Array<{ id: number; kind?: string; role?: string; prompt?: string; aspect?: string }>;
  };
  return {
    primary: j.primary || '#c45c12',
    secondary: j.secondary || '#3f2a1d',
    accent: j.accent || '#d4a017',
    background: j.background || '#faf7f2',
    ink: j.ink || '#1a1410',
    world: j.world || '',
    avatar: j.avatar || '',
    slots: (j.slots || []).filter((s) => slots.some((x) => x.id === s.id) && s.prompt),
  };
}

async function callClaude(system: string, user: string): Promise<string> {
  const key = requireAnthropicKey();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SWIPE_MODEL_DEFAULT,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`Claude plan HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  if (!text.trim()) throw new Error('Claude returned an empty visual plan');
  return text;
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
    const { data: pub } = supabaseAdmin.storage.from(PROJECT_FILES_BUCKET).getPublicUrl(main.file_path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}
