import { NextRequest, NextResponse } from 'next/server';
import { ingestDataset, webhookSecret } from '@/lib/competitor-scrape';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The netlify.toml raises the Next handler ceiling to 300s (Pro), so we can
// afford to download + upload longer video creatives here.
export const maxDuration = 300;

/**
 * Apify run webhook. Called when a competitor Ad Library run finishes.
 * Context (projectId, brandId, secret) travels in the query string; Apify
 * appends the run payload (resource.defaultDatasetId, status) in the body.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') || '';
  const brandId = Number(url.searchParams.get('brandId') || '0');
  const provided = url.searchParams.get('secret') || '';

  const expected = webhookSecret();
  if (expected && provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!projectId || !brandId) {
    return NextResponse.json({ error: 'Missing context' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const resource = body?.resource || {};
  const status: string = resource.status || body?.eventType || '';
  const datasetId: string = resource.defaultDatasetId || '';

  // Only ingest successful runs; ack everything else so Apify stops retrying.
  if (status && !/SUCCEEDED/i.test(status)) {
    return NextResponse.json({ ok: true, ignored: status });
  }
  if (!datasetId) {
    return NextResponse.json({ ok: true, ignored: 'no dataset' });
  }

  const result = await ingestDataset({ projectId, brandId, datasetId });
  return NextResponse.json({ ok: true, ...result });
}
