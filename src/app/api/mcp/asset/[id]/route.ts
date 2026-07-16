import { NextRequest, NextResponse } from 'next/server';
import { getAsset } from '@/lib/mcp/asset-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves a cloned/rewritten asset as real HTML so the user can open the
 * previewUrl/downloadUrl handed back by the MCP tools in a browser.
 *
 *   /api/mcp/asset/:id                  -> rewritten HTML (falls back to original)
 *   /api/mcp/asset/:id?variant=original -> original clone
 *   /api/mcp/asset/:id?download=1       -> forces a file download
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const asset = await getAsset(params.id);
  if (!asset) {
    return NextResponse.json({ error: 'asset not found' }, { status: 404 });
  }

  const variant = req.nextUrl.searchParams.get('variant');
  const download = req.nextUrl.searchParams.get('download');
  const html =
    variant === 'original'
      ? asset.html
      : asset.resultHtml || asset.html;

  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (download) {
    const safe = (asset.title || 'page').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60);
    headers['content-disposition'] = `attachment; filename="${safe || 'page'}.html"`;
  }

  return new NextResponse(html, { status: 200, headers });
}
