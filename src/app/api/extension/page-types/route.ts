import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/get-current-user';
import {
  deleteArchivePageType,
  listArchivePageTypes,
  resolvePageType,
  upsertArchivePageType,
} from '@/lib/archive-page-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * User-defined archive page types (extra funnel steps: "Upsell 4", …).
 * Shared between Templates → By Type folders and the browser extension.
 *
 * GET    → { types: { value, label }[] }
 * POST   → { name } or { value, label }  create a type (and its folder)
 * DELETE → ?value=... remove a type from the known list (pages stay)
 */

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ success: true, types: await listArchivePageTypes(userId) });
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const raw = String(body?.value || body?.name || body?.label || '').trim();
  if (!raw) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  const resolved = resolvePageType(
    String(body?.value || body?.name || ''),
    String(body?.label || body?.name || ''),
  );

  let persisted = true;
  if (resolved.isCustom) {
    persisted = await upsertArchivePageType(userId, resolved.value, resolved.label);
  }

  return NextResponse.json({
    success: true,
    persisted,
    value: resolved.value,
    label: resolved.label,
    types: await listArchivePageTypes(userId),
  });
}

export async function DELETE(req: NextRequest) {
  const userId = await getCurrentUserId(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const value = req.nextUrl.searchParams.get('value') || '';
  if (!value) return NextResponse.json({ error: 'value is required' }, { status: 400 });

  await deleteArchivePageType(userId, value);
  return NextResponse.json({ success: true, types: await listArchivePageTypes(userId) });
}
