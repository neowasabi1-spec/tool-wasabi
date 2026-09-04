import { NextRequest, NextResponse } from 'next/server';
import { placeMediaWithAi, type PlaceLibIn, type PlaceSlotIn } from '@/lib/restyle-place';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    productName?: string;
    brief?: string;
    description?: string;
    pageUrl?: string;
    slots?: PlaceSlotIn[];
    library?: PlaceLibIn[];
  };
  const productName = String(body.productName || '').trim();
  const slots = Array.isArray(body.slots) ? body.slots : [];
  const library = Array.isArray(body.library) ? body.library : [];
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
    });
    return NextResponse.json({ assignments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Place failed' }, { status: 502 });
  }
}
