/**
 * TEMPORARY — diagnose long-video download failures. Token-guarded. REMOVE.
 * Lists recent video ads, tests createSignedUrl on each, reports file size.
 */
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOKEN = 'wsb-diag-8f3a1c6e2b';
const BUCKET = 'project-files';

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const { data: ads, error } = await supabaseAdmin
    .from('competitor_ads')
    .select('id, file_path, media_type, created_at')
    .eq('media_type', 'video')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const report = [];
  for (const ad of ads || []) {
    const fp = String(ad.file_path || '');
    const entry: Record<string, unknown> = { id: ad.id, file_path: fp.slice(0, 120) };
    if (/^https?:\/\//i.test(fp)) {
      entry.kind = 'remote-url';
    } else {
      entry.kind = 'storage';
      try {
        const { data: signed, error: sErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUrl(fp, 600, { download: 'test.mp4' });
        entry.signError = sErr ? sErr.message : null;
        if (signed?.signedUrl) {
          entry.signedOk = true;
          // HEAD the signed URL to confirm the CDN serves it + get the size.
          try {
            const h = await fetch(signed.signedUrl, { method: 'HEAD' });
            entry.cdnStatus = h.status;
            entry.cdnLength = h.headers.get('content-length');
            entry.cdnType = h.headers.get('content-type');
          } catch (e) {
            entry.cdnError = e instanceof Error ? e.message : String(e);
          }
        }
      } catch (e) {
        entry.signThrew = e instanceof Error ? e.message : String(e);
      }
    }
    report.push(entry);
  }
  return NextResponse.json({ report });
}
