/**
 * Bridge Wasabi competitor_ads / own_ads into Jev creatives pipeline.
 */
import { createHash } from 'crypto';
import { db, must } from '../db';
import { progress } from '../jobs';
import { extFor, putMedia, sha256 } from '../storage';
import { getUploadUrl } from '@/lib/projecthub-storage';

async function ensureDefaultProduct(projectId: string): Promise<string> {
  const { data: existing } = await db()
    .from('jev_products')
    .select('id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return String(existing.id);

  const row = must(
    await db()
      .from('jev_products')
      .insert({
        project_id: projectId,
        name: 'Default product',
        description: '',
        source_mode: 'same_benefit',
        benefit: '',
      })
      .select('id')
      .single(),
  ) as { id: string };
  return row.id;
}

async function downloadToBuffer(urlOrPath: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const raw = (urlOrPath || '').trim();
  if (!raw) return null;
  let url = raw;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      url = getUploadUrl(raw);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, contentType: ct };
  } catch {
    return null;
  }
}

export async function ingestCompetitorAd(
  projectId: string,
  competitorAdId: string | number,
  jobId?: string,
): Promise<{ creativeId: string; adId: string }> {
  await progress(jobId, 'Loading competitor ad…');
  const ad = must(
    await db().from('competitor_ads').select('*').eq('project_id', projectId).eq('id', competitorAdId).single(),
  ) as Record<string, unknown>;

  const productId = await ensureDefaultProduct(projectId);
  const mediaType = String(ad.media_type || 'image').includes('video') ? 'video' : 'image';
  const filePath = String(ad.file_path || '');
  const downloaded = await downloadToBuffer(filePath);

  let mediaHash = createHash('sha256').update(`${projectId}:${competitorAdId}:${filePath}`).digest('hex');
  let mediaPaths: string[] = filePath ? [filePath] : [];

  if (downloaded) {
    mediaHash = sha256(downloaded.buf);
    const ext = extFor(downloaded.contentType);
    const path = `${projectId}/jev/creatives/${mediaHash}.${ext}`;
    await putMedia(path, downloaded.buf, downloaded.contentType);
    mediaPaths = [path];
  }

  await progress(jobId, 'Upserting creative…');
  const creative = must(
    await db()
      .from('jev_creatives')
      .upsert(
        {
          project_id: projectId,
          product_id: productId,
          media_type: mediaType,
          media_hash: mediaHash,
          media_paths: mediaPaths,
          bodies: [String(ad.body_text || '')].filter(Boolean),
          titles: [String(ad.headline || ad.name || '')].filter(Boolean),
          captions: [String(ad.hook || '')].filter(Boolean),
          active: ad.ad_active !== false && ad.ad_active !== 'false',
          extraction_status: mediaPaths.length ? 'pending' : 'no_media',
        },
        { onConflict: 'project_id,media_hash' },
      )
      .select('id')
      .single(),
  ) as { id: string };

  const libraryId = String(ad.external_id || `wasabi-competitor-${competitorAdId}`);
  const adRow = must(
    await db()
      .from('jev_ads')
      .upsert(
        {
          library_id: libraryId,
          creative_id: creative.id,
          page_name: String(ad.name || ''),
          active: true,
          raw: ad,
        },
        { onConflict: 'library_id' },
      )
      .select('id')
      .single(),
  ) as { id: string };

  return { creativeId: creative.id, adId: adRow.id };
}

export async function ingestOwnAd(
  projectId: string,
  ownAdId: string | number,
  jobId?: string,
): Promise<{ creativeId: string; adId: string }> {
  await progress(jobId, 'Loading own ad…');
  const ad = must(
    await db().from('own_ads').select('*').eq('project_id', projectId).eq('id', ownAdId).single(),
  ) as Record<string, unknown>;

  const productId = await ensureDefaultProduct(projectId);
  const mediaType = String(ad.media_type || 'image').includes('video') ? 'video' : 'image';
  const url = String(ad.media_url || ad.thumbnail_url || '');
  const downloaded = await downloadToBuffer(url);

  let mediaHash = createHash('sha256').update(`${projectId}:own:${ad.external_ad_id}`).digest('hex');
  let mediaPaths: string[] = [];
  if (downloaded) {
    mediaHash = sha256(downloaded.buf);
    const ext = extFor(downloaded.contentType);
    const path = `${projectId}/jev/creatives/${mediaHash}.${ext}`;
    await putMedia(path, downloaded.buf, downloaded.contentType);
    mediaPaths = [path];
  }

  const creative = must(
    await db()
      .from('jev_creatives')
      .upsert(
        {
          project_id: projectId,
          product_id: productId,
          media_type: mediaType,
          media_hash: mediaHash,
          media_paths: mediaPaths,
          bodies: [String(ad.body_text || '')].filter(Boolean),
          titles: [String(ad.headline || ad.ad_name || '')].filter(Boolean),
          active: true,
          extraction_status: mediaPaths.length ? 'pending' : 'no_media',
        },
        { onConflict: 'project_id,media_hash' },
      )
      .select('id')
      .single(),
  ) as { id: string };

  const libraryId = `wasabi-own-${ad.external_ad_id}`;
  const adRow = must(
    await db()
      .from('jev_ads')
      .upsert(
        {
          library_id: libraryId,
          creative_id: creative.id,
          page_name: 'own',
          active: true,
          raw: ad,
        },
        { onConflict: 'library_id' },
      )
      .select('id')
      .single(),
  ) as { id: string };

  return { creativeId: creative.id, adId: adRow.id };
}
