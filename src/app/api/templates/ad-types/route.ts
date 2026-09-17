import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import {
  deleteArchiveAdType,
  listArchiveAdTypes,
  resolveAdType,
  upsertArchiveAdType,
} from '@/lib/archive-ad-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ success: true, types: await listArchiveAdTypes(userId) });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const raw = String(body?.value || body?.name || body?.label || '').trim();
  if (!raw) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  const resolved = resolveAdType(
    String(body?.value || body?.name || ''),
    String(body?.label || body?.name || ''),
  );

  let persisted = true;
  if (resolved.isCustom) {
    persisted = await upsertArchiveAdType(userId, resolved.value, resolved.label);
  }

  return NextResponse.json({
    success: true,
    persisted,
    value: resolved.value,
    label: resolved.label,
    types: await listArchiveAdTypes(userId),
  });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const value = req.nextUrl.searchParams.get('value') || '';
  if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 });

  await deleteArchiveAdType(userId, value);
  return NextResponse.json({ success: true, types: await listArchiveAdTypes(userId) });
}
