/**
 * Server-side download proxy for files stored in the Supabase Storage bucket
 * `project-files`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original projecthub UI used `getPublicUrlForFile()` to build a direct
 * Supabase public URL like:
 *     https://<project>.supabase.co/storage/v1/object/public/project-files/<path>
 *
 * That URL only works when the bucket is set to PUBLIC. The migration
 * comments mention this but bucket-creation is a manual step in the Supabase
 * Console, so users frequently end up with the bucket either missing or set
 * to private — which makes every uploaded brief / market-research doc return
 * 404 ("documento non presente quando lo scarico").
 *
 * This proxy uses the server-side Supabase client (anon key) to download the
 * object via the JS SDK, then streams it back to the browser. It works
 * regardless of whether the bucket is public or private. Auth-wise this is
 * equivalent to the public URL approach (anyone with the path can download)
 * — Wasabi is single-tenant so that's fine.
 *
 * Usage:
 *   GET /api/projecthub/file-proxy?path=<projectId>/<file_type>/<filename>
 *   GET /api/projecthub/file-proxy?path=<projectId>/<file_type>/<filename>&download=1
 *                                                                          ^^^^^^^^^^
 *                                                                          forces Content-Disposition: attachment
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BUCKET = 'project-files';

function mimeFromExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',
    json: 'application/json; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    yaml: 'application/yaml; charset=utf-8',
    yml: 'application/yaml; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    rtf: 'application/rtf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  const wantDownload = url.searchParams.get('download') === '1';

  if (!path) {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 });
  }

  // Defensive: prevent path traversal and absolute paths. Storage keys are
  // always project-scoped (e.g. "<uuid>/<file_type>/<filename>").
  if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || 'File not found' },
      { status: 404 },
    );
  }

  const filename = path.split('/').pop() || 'download';
  // Strip the timestamp prefix the upload route adds (e.g.
  // "1718291234_brief.pdf" → "brief.pdf") for a friendly download name.
  const friendly = filename.replace(/^\d{10,}_/, '');
  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);

  const headers = new Headers();
  headers.set('Content-Type', data.type || mimeFromExt(filename));
  headers.set('Content-Length', String(buf.length));
  headers.set('Cache-Control', 'private, max-age=3600');
  // RFC 5987 filename* covers non-ASCII filenames; the legacy filename= keeps
  // older browsers happy.
  const encoded = encodeURIComponent(friendly);
  const disposition = wantDownload ? 'attachment' : 'inline';
  headers.set(
    'Content-Disposition',
    `${disposition}; filename="${friendly.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`,
  );

  return new NextResponse(buf, { status: 200, headers });
}
