import { NextRequest, NextResponse } from 'next/server';
import { requireAnthropicKey } from '@/lib/anthropic-key';
import { fetchPreview } from '@/lib/restyle-place';
import { expandPaletteMap, normalizeHex, type Palette, type PaletteMap } from '@/lib/restyle-slots';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Design the colour world for OUR product and map the competitor page's
 * brand hexes onto it. The model decides from the product (name, brief,
 * description, photo when available) — nothing here guesses from keywords.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    productName?: string;
    brief?: string;
    description?: string;
    colors?: string[];
    projectId?: string;
    productImageUrl?: string;
  };
  const productName = String(body.productName || '').trim();
  const colors = (Array.isArray(body.colors) ? body.colors : [])
    .map((c) => normalizeHex(String(c)))
    .filter(Boolean)
    .slice(0, 14);
  if (!productName) return NextResponse.json({ error: 'productName required' }, { status: 400 });

  try {
    const productImageUrl =
      String(body.productImageUrl || '').trim()
      || (body.projectId ? await loadProductImage(String(body.projectId)) : '')
      || '';
    const result = await designPalette({
      productName,
      brief: String(body.brief || '').slice(0, 1200),
      description: String(body.description || '').slice(0, 800),
      colors,
      productImageUrl,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Palette failed' }, { status: 502 });
  }
}

async function loadProductImage(projectId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from('project_files')
      .select('file_path, original_name, created_at')
      .eq('project_id', projectId)
      .eq('file_type', 'product_image')
      .order('created_at', { ascending: false })
      .limit(20);
    const rows = (data || []) as Array<{ file_path: string; original_name?: string | null }>;
    if (!rows.length) return '';
    const main = rows.find((r) => !/upsell/i.test(r.original_name || '')) || rows[0];
    const { data: pub } = supabaseAdmin.storage.from('project-files').getPublicUrl(main.file_path);
    return pub?.publicUrl || '';
  } catch {
    return '';
  }
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

async function designPalette(args: {
  productName: string;
  brief: string;
  description: string;
  colors: string[];
  productImageUrl: string;
}): Promise<{ palette: Palette; map: PaletteMap }> {
  const system = `You are an art director. A competitor landing page is being turned into a page for OUR product "${args.productName}". Same layout. The colour world IS the packshot — like premium DTC jelly/skincare landers (saffron/burgundy, NAD+ purple, collagen rose, pomegranate green).
${args.description ? `Product: ${args.description}\n` : ''}${args.brief ? `Brief: ${args.brief}\n` : ''}
Rules:
- Body copy stays black on light areas; dark product-coloured bands keep white text.
- primary = strongest pack colour, for CTAs (readable with white text).
- secondary = darker sibling of the pack for icon strips and footer.
- accent = supporting highlight from the pack (gold, berry, leaf…).
- background = a very light tint of the pack colour (never generic gray).
- "map": for EVERY old hex listed, give the new hex it should become so the page reads as ours. Keep light tints light and dark tones dark (same role, our hue). Do not map to pure black or pure white.
If a product photo is attached, take primary/secondary/accent FROM that photo.
Return STRICT JSON only:
{"primary":"#rrggbb","secondary":"#rrggbb","accent":"#rrggbb","background":"#rrggbb","map":[{"from":"#old","to":"#new"}]}`;

  const content: ContentPart[] = [];
  if (args.productImageUrl) {
    const img = await fetchPreview(args.productImageUrl);
    if (img) {
      content.push({ type: 'text', text: 'Photo of OUR product — take the colour world from it:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
  }
  content.push({
    type: 'text',
    text: `Old page brand hexes (most used first): ${args.colors.join(', ') || '(none)'}`,
  });

  const key = requireAnthropicKey();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`Palette HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  return parsePalette(text, args.colors);
}

function parsePalette(raw: string, oldColors: string[]): { palette: Palette; map: PaletteMap } {
  let c = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const a = c.indexOf('{');
  const b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  const obj = JSON.parse(c) as Record<string, unknown>;
  const hex = (v: unknown) => normalizeHex(String(v || ''));
  const primary = hex(obj.primary);
  const secondary = hex(obj.secondary);
  if (!primary || !secondary) throw new Error('Palette missing primary/secondary');
  const palette: Palette = {
    primary,
    secondary,
    accent: hex(obj.accent) || primary,
    background: hex(obj.background) || '#ffffff',
    ink: '#111111',
  };
  const known = new Set(oldColors);
  const map: PaletteMap = (Array.isArray(obj.map) ? (obj.map as Array<Record<string, unknown>>) : [])
    .map((p) => ({ from: hex(p.from), to: hex(p.to) }))
    .filter((p) => p.from && p.to && known.has(p.from));
  return { palette, map: expandPaletteMap(oldColors, palette, map) };
}
