import { db, must } from '../db';
import { dhash, isImage } from '../imagehash';
import { enqueue, progress } from '../jobs';
import { fetchPageAds } from '../meta/adLibrary';
import { scrapePageAds, type PublicAd } from '../meta/publicLibrary';
import { download } from '../meta/snapshot';
import { getFbToken, getThresholds } from '../settings';
import { extFor, putMedia, sha256 } from '../storage';
import type { Source } from '../types';

const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => !!x && !!x.trim()))];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Scarica le ads di una fonte e mette in coda l'analisi delle creatività nuove.
 * Fonte principale: la Ad Library PUBBLICA letta con un browser automatico, ordinata per impression.
 * (La Ad Library API per le ads commerciali restituisce solo quelle distribuite in UE.)
 */
export async function refreshSource(sourceId: string, jobId?: string) {
  const source = must(await db().from('jev_sources').select('*').eq('id', sourceId).single()) as Source;
  if (source.kind !== 'page' || !source.page_id) {
    await db().from('jev_sources').update({ last_refreshed_at: new Date().toISOString() }).eq('id', sourceId);
    return { skipped: 'fonte non è una pagina' };
  }
  const th = await getThresholds();
  await progress(jobId, `Ad Library pubblica: ${source.name || source.page_id}`);

  let ads: PublicAd[];
  let totalLabel: string | null = null;
  let pageName: string | null = null;
  try {
    const r = await scrapePageAds(source.page_id, {
      activeStatus: 'all',
      max: th.maxAdsPerPage,
      onProgress: (n) => progress(jobId, `Ad Library pubblica: ${n} ads caricate`),
    });
    ads = r.ads;
    totalLabel = r.totalLabel;
    pageName = r.pageName;
  } catch (e) {
    // Ripiego: API (solo ads UE), se c'è un token
    if (!(await getFbToken())) throw e;
    await progress(jobId, `Pagina pubblica non leggibile (${e instanceof Error ? e.message : e}); uso l'API (solo ads UE)`);
    ads = await fromApi(source.page_id);
  }
  // Nome attuale: intestazione della pagina, altrimenti l'ad attiva più recente (non la prima in classifica, che può essere vecchia)
  const latestActive = ads.filter((a) => a.active && a.page_name).sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')))[0];
  // l'intestazione vale solo se coincide con un nome presente sulle ads (in modalità headless può leggere altri titoli)
  const headerName = pageName && ads.some((x) => x.page_name === pageName) ? pageName : null;
  const latestAny = [...ads].filter((x) => x.page_name).sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')))[0];
  const currentName = latestActive?.page_name || headerName || latestAny?.page_name || null;
  if (currentName && currentName !== source.name) {
    const note = source.name ? `Nome precedente: ${source.name}` : source.status_note;
    await db().from('jev_sources').update({ name: currentName, status_note: note }).eq('id', sourceId);
  }

  const existing = new Map<string, string>(); // library_id → creative_id
  for (let i = 0; i < ads.length; i += 500) {
    const { data } = await db().from('jev_ads').select('library_id, creative_id').in('library_id', ads.slice(i, i + 500).map((a) => a.library_id));
    for (const r of data ?? []) existing.set(r.library_id, r.creative_id);
  }

  let created = 0, merged = 0, updated = 0, failed = 0;
  const touched = new Set<string>();
  for (const [i, ad] of ads.entries()) {
    if (i % 5 === 0) await progress(jobId, `Ads ${i}/${ads.length} · nuove creatività ${created} · duplicati ${merged}`);
    const common = {
      stop_date: ad.stop_date,
      active: ad.active,
      impression_rank: ad.impression_rank,
      impression_total: ads.length,
      shared_copies: ad.copies,
      multi_version: ad.multi_version,
      eu_transparency: ad.eu_transparency,
    };
    const known = existing.get(ad.library_id);
    if (known) {
      await db().from('jev_ads').update(common).eq('library_id', ad.library_id);
      touched.add(known);
      updated++;
      continue;
    }
    try {
      const { creativeId, isNew } = await ingestAd(source, ad, common);
      touched.add(creativeId);
      if (isNew) created++; else merged++;
    } catch (e) {
      failed++;
      console.error(`Ad ${ad.library_id}:`, e);
    }
  }

  await progress(jobId, 'Aggiornamento classifica, date e stato delle creatività');
  for (const cid of touched) await refreshCreativeAggregates(cid);
  await db().from('jev_sources').update({ last_refreshed_at: new Date().toISOString(), last_total_label: totalLabel }).eq('id', sourceId);
  return { site: totalLabel, read: ads.length, created, merged, updated, failed };
}

async function ingestAd(source: Source, ad: PublicAd, common: Record<string, unknown>): Promise<{ creativeId: string; isNew: boolean }> {
  // I link ai media di Facebook scadono: si scaricano subito
  let media: { buf: Buffer; contentType: string }[] = [];
  let poster: { buf: Buffer; contentType: string } | null = null;
  let mediaType: 'text' | 'image' | 'video' | 'carousel' = 'text';
  try {
    if (ad.video_url) {
      media = [await download(ad.video_url)];
      mediaType = 'video';
      if (ad.poster_url) poster = await download(ad.poster_url).catch(() => null);
    } else if (ad.image_urls.length) {
      media = await Promise.all(ad.image_urls.slice(0, 10).map(download));
      mediaType = media.length > 1 ? 'carousel' : 'image';
    }
  } catch (e) {
    console.warn(`Media ${ad.library_id}: ${e instanceof Error ? e.message : e}`);
    media = [];
    mediaType = 'text';
  }

  const hash = media.length ? sha256(Buffer.concat(media.map((m) => m.buf))) : sha256(`text:${ad.body}|${ad.headline}`);
  const { data: found } = await db().from('jev_creatives').select('*').eq('project_id', source.project_id).eq('media_hash', hash).maybeSingle();
  let creativeId: string;
  let isNew = false;
  if (found) {
    creativeId = found.id;
    await db().from('jev_creatives').update({
      bodies: uniq([...found.bodies, ad.body]),
      titles: uniq([...found.titles, ad.headline]),
      descriptions: uniq([...found.descriptions, ad.description]),
      captions: uniq([...found.captions, ad.caption]),
      ctas: uniq([...(found.ctas ?? []), ad.cta]),
    }).eq('id', creativeId);
  } else {
    const paths: string[] = [];
    const hashes: string[] = [];
    for (const [i, m] of media.entries()) {
      paths.push(await putMedia(`${source.project_id}/creatives/${hash}/${i}.${extFor(m.contentType)}`, m.buf, m.contentType));
      if (mediaType !== 'video' && (await isImage(m.buf))) hashes.push(await dhash(m.buf));
    }
    let posterPath: string | null = null;
    if (poster && (await isImage(poster.buf))) {
      posterPath = await putMedia(`${source.project_id}/creatives/${hash}/poster.${extFor(poster.contentType)}`, poster.buf, poster.contentType);
      hashes.push(await dhash(poster.buf));
    }
    const row = must(await db().from('jev_creatives').insert({
      project_id: source.project_id,
      source_id: source.id,
      media_type: mediaType,
      media_hash: hash,
      media_paths: paths,
      poster_path: posterPath,
      dhashes: hashes,
      bodies: uniq([ad.body]),
      titles: uniq([ad.headline]),
      descriptions: uniq([ad.description]),
      captions: uniq([ad.caption]),
      ctas: uniq([ad.cta]),
      first_seen: ad.start_date,
      last_seen: ad.stop_date ?? today(),
      active: ad.active,
      extraction_status: 'pending',
    }).select('id').single()) as { id: string };
    creativeId = row.id;
    isNew = true;
    await enqueue('extract_creative', { creativeId }, source.project_id);
  }

  await db().from('jev_ads').insert({
    library_id: ad.library_id,
    creative_id: creativeId,
    source_id: source.id,
    page_name: ad.page_name,
    start_date: ad.start_date,
    video_duration_s: ad.video_duration_s,
    raw: { ...ad, video_url: null, poster_url: null, image_urls: [] },
    ...common,
  });
  return { creativeId, isNew };
}

/** Ripiego sull'API: stesse informazioni essenziali, senza media né classifica reale. */
async function fromApi(pageId: string): Promise<PublicAd[]> {
  const rows = await fetchPageAds(pageId);
  return rows.map((a, i) => ({
    library_id: a.id,
    impression_rank: i + 1,
    active: !a.ad_delivery_stop_time,
    start_date: a.ad_delivery_start_time?.slice(0, 10) ?? null,
    stop_date: a.ad_delivery_stop_time?.slice(0, 10) ?? null,
    body: a.ad_creative_bodies?.[0] ?? '',
    headline: a.ad_creative_link_titles?.[0] ?? '',
    description: a.ad_creative_link_descriptions?.[0] ?? '',
    caption: a.ad_creative_link_captions?.[0] ?? '',
    cta: '',
    video_url: null,
    poster_url: null,
    image_urls: [],
    video_duration_s: null,
    multi_version: false,
    copies: 1,
    eu_transparency: true,
    page_name: a.page_name ?? '',
  }));
}

/** Copie, date, stato e posizione per impression della creatività = aggregato delle ads che la usano. */
export async function refreshCreativeAggregates(creativeId: string) {
  const { data: rows } = await db().from('jev_ads').select('start_date, stop_date, active, impression_rank, impression_total, shared_copies').eq('creative_id', creativeId);
  if (!rows?.length) return;
  const starts = rows.map((r) => r.start_date).filter(Boolean).sort();
  const ends = rows.map((r) => (r.active ? today() : r.stop_date)).filter(Boolean).sort();
  const ranked = rows.filter((r) => r.impression_rank != null);
  const best = ranked.sort((a, b) => a.impression_rank - b.impression_rank)[0];
  await db().from('jev_creatives').update({
    copies: Math.max(rows.length, ...rows.map((r) => r.shared_copies ?? 1)),
    active: rows.some((r) => r.active),
    first_seen: starts[0] ?? null,
    last_seen: ends[ends.length - 1] ?? null,
    impression_rank: best?.impression_rank ?? null,
    impression_pct: best && best.impression_total > 1 ? (best.impression_rank - 1) / (best.impression_total - 1) : best ? 0 : null,
  }).eq('id', creativeId);
}

export async function refreshProduct(productId: string, jobId?: string) {
  const { data } = await db().from('jev_product_sources').select('source_id').eq('product_id', productId);
  const results: Record<string, unknown> = {};
  for (const r of data ?? []) results[r.source_id] = await refreshSource(r.source_id, jobId);
  return results;
}

export async function refreshProject(projectId: string, jobId?: string) {
  const { data } = await db().from('jev_sources').select('id').eq('project_id', projectId).eq('kind', 'page');
  const results: Record<string, unknown> = {};
  for (const r of data ?? []) results[r.id] = await refreshSource(r.id, jobId);
  return results;
}
