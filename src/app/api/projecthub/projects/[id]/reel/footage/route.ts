import { NextRequest, NextResponse } from 'next/server';
import { canAccessProject } from '@/lib/auth/project-access';
import {
  listCleanedShots,
  listCleanedFullAds,
  importReelFootage,
  reelFootageStatus,
  usableStorageKey,
  resolveProjectFootageDir,
  resolveProjectFullCleanedDir,
} from '@/lib/reel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type FootageOpts = {
  brandId?: number;
  adId?: number;
  cleanedOnly?: boolean;
  includeFullAds?: boolean;
  limit?: number;
};

function parseOpts(
  id: string,
  sp: URLSearchParams,
  body?: Record<string, unknown>,
): FootageOpts {
  const brandRaw = body?.brandId ?? sp.get('brandId');
  const adRaw = body?.adId ?? sp.get('adId');
  const brandId =
    brandRaw != null && Number.isFinite(Number(brandRaw))
      ? Number(brandRaw)
      : undefined;
  const adId =
    adRaw != null && Number.isFinite(Number(adRaw)) ? Number(adRaw) : undefined;
  const cleanedOnly =
    body?.cleanedOnly === true || sp.get('cleanedOnly') === '1';
  const includeFullAds =
    body?.includeFullAds !== false && sp.get('includeFullAds') !== '0';
  const limitRaw = body?.limit ?? sp.get('limit');
  const limit =
    limitRaw != null && Number.isFinite(Number(limitRaw))
      ? Number(limitRaw)
      : undefined;
  return {
    brandId,
    adId,
    cleanedOnly: cleanedOnly || undefined,
    includeFullAds,
    limit,
  };
}

async function buildInventory(projectId: string, opts: FootageOpts) {
  const [shots, fullAds] = await Promise.all([
    listCleanedShots({
      projectId,
      brandId: opts.brandId,
      adId: opts.adId,
      cleanedOnly: opts.cleanedOnly ?? false,
      limit: opts.limit,
    }),
    opts.includeFullAds === false
      ? Promise.resolve([])
      : listCleanedFullAds({
          projectId,
          brandId: opts.brandId,
          adId: opts.adId,
          limit: opts.limit,
        }),
  ]);

  return {
    projectId,
    brandId: opts.brandId ?? null,
    adId: opts.adId ?? null,
    exportedAt: new Date().toISOString(),
    localPaths: {
      footageDir: resolveProjectFootageDir(projectId),
      fullDir: resolveProjectFullCleanedDir(projectId),
    },
    shots: shots.map((s) => ({
      id: s.id,
      adId: s.ad_id ?? null,
      brandId: s.brand_id ?? null,
      storageKey: usableStorageKey(s),
      durationSec: s.duration_sec ?? null,
      caption: s.caption ?? null,
      action: s.action ?? null,
      suggestedLocalName: `shot-${s.id}.${(usableStorageKey(s) || '').split('.').pop()?.toLowerCase() || 'mp4'}`,
    })),
    fullAds: fullAds.map((a) => ({
      id: a.id,
      brandId: a.brand_id,
      name: a.name ?? null,
      storageKey: a.clean_full_path,
      suggestedLocalName: `ad-${a.id}.${String(a.clean_full_path || '').split('.').pop()?.toLowerCase() || 'mp4'}`,
    })),
  };
}

/**
 * GET — status counts + full cleaned ads metadata (no download).
 * ?brandId= optional filter
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const opts = parseOpts(id, req.nextUrl.searchParams);
  const [status, fullAds] = await Promise.all([
    reelFootageStatus(id),
    listCleanedFullAds({
      projectId: id,
      brandId: opts.brandId,
      limit: opts.limit,
    }),
  ]);

  return NextResponse.json({
    ...status,
    fullAds: fullAds.map((a) => ({
      id: a.id,
      brand_id: a.brand_id,
      name: a.name ?? null,
      clean_full_path: a.clean_full_path,
    })),
  });
}

/**
 * POST — inventory (default) or local download via importReelFootage.
 * Body: { brandId?, adId?, cleanedOnly?, includeFullAds?, download?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const { allowed } = await canAccessProject(req, id);
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const opts = parseOpts(id, req.nextUrl.searchParams, body);
  const download = body.download === true;

  if (!download) {
    const inventory = await buildInventory(id, opts);
    return NextResponse.json({ mode: 'inventory', ...inventory });
  }

  try {
    const result = await importReelFootage({
      projectId: id,
      brandId: opts.brandId,
      adId: opts.adId,
      cleanedOnly: opts.cleanedOnly ?? true,
      includeFullAds: opts.includeFullAds ?? true,
      limit: opts.limit,
    });
    return NextResponse.json({
      mode: 'download',
      footageDir: result.footageDir,
      fullDir: result.fullDir,
      manifestPath: result.manifestPath,
      importedShotsCount: result.shots.length,
      importedFullAdsCount: result.fullAds.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const inventory = await buildInventory(id, opts).catch(() => null);
    return NextResponse.json(
      {
        error:
          'Local download is only on the Claude Cloud reel engine host (engine worker). Netlify cannot write to disk — use Create video on engine from the UI.',
        detail: message,
        inventory,
      },
      { status: 501 },
    );
  }
}
