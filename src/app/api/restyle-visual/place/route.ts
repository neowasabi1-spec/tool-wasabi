import { NextRequest, NextResponse } from 'next/server';
import { placeMediaWithAi, type PlaceLibIn, type PlaceSlotIn } from '@/lib/restyle-place';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

type LibInWithPath = PlaceLibIn & { filePath?: string };

/** Storage path → URL the server can fetch, so the model sees each library file. */
function previewUrlFor(item: LibInWithPath): string {
  if (item.previewUrl && /^https?:\/\//i.test(item.previewUrl)) return item.previewUrl;
  const path = String(item.filePath || '').trim();
  if (!path || /^https?:\/\//i.test(path)) return '';
  const { data } = supabaseAdmin.storage.from('project-files').getPublicUrl(path);
  return data?.publicUrl || '';
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    productName?: string;
    brief?: string;
    description?: string;
    pageUrl?: string;
    slots?: PlaceSlotIn[];
    library?: LibInWithPath[];
  };
  const productName = String(body.productName || '').trim();
  const slots = Array.isArray(body.slots) ? body.slots : [];
  const library: PlaceLibIn[] = (Array.isArray(body.library) ? body.library : []).map((m) => ({
    id: String(m.id),
    kind: String(m.kind || 'image'),
    name: String(m.name || ''),
    file: String(m.file || ''),
    previewUrl: previewUrlFor(m),
  }));
  if (!productName || !slots.length) {
    return NextResponse.json({ error: 'productName and slots required' }, { status: 400 });
  }
  try {
    const assignments = await placeMediaWithAi({
      productName,
      brief: body.brief,
      description: body.description,
      pageUrl: body.pageUrl,
      slots,
      library,
      // Restyle turns a cloned competitor page into ours: old-product pictures go.
      convert: true,
    });
    return NextResponse.json({ assignments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Place failed' }, { status: 502 });
  }
}
