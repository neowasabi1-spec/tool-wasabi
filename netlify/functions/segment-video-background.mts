import fs from 'fs';
import path from 'path';
import {
  getSupabase, ffprobeInfo, detectScenes, buildSegments, cutClip, grabThumb,
  analyzeShot, downloadSource, uploadFile, makeWorkDir, autoCleanShots, selfOrigin,
} from './_shared/video';

/**
 * Background function (up to 15 min) that splits a competitor video into
 * individual "shots" using ffmpeg. Triggered fire-and-forget by the segment
 * enqueue API route. Reads the already-created video_segment_jobs row, does the
 * work, writes competitor_shots, and flips the job to done/error.
 *
 * Body: { jobId, projectId, brandId, adId }
 */
export default async (req: Request) => {
  let body: { jobId?: number; projectId?: string; brandId?: number; adId?: number };
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const { jobId, projectId, brandId, adId } = body;
  if (!jobId || !projectId || !brandId || !adId) {
    return new Response('missing fields', { status: 400 });
  }

  const supabase = getSupabase();
  const log = (...a: unknown[]) => console.log('[segment-bg]', `job#${jobId}`, ...a);

  // Claim: only proceed if still pending (avoids double-run).
  const { data: claimed } = await supabase
    .from('video_segment_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (!claimed) {
    log('already claimed / not pending — skipping');
    return new Response('skip', { status: 200 });
  }

  const workDir = makeWorkDir('wshots-');
  const srcFile = path.join(workDir, 'src.mp4');
  let shotsCount = 0;
  const subtitled: number[] = [];
  try {
    const { data: ad } = await supabase
      .from('competitor_ads')
      .select('id, file_path, media_type')
      .eq('id', adId)
      .maybeSingle();
    if (!ad) throw new Error('ad not found');
    if (ad.media_type !== 'video') throw new Error('ad is not a video');
    if (!ad.file_path) throw new Error('ad has no file_path');

    await downloadSource(supabase, ad.file_path, srcFile);
    const info = await ffprobeInfo(srcFile);
    if (!info.duration) throw new Error('could not read video duration');
    log(`duration ${info.duration.toFixed(1)}s ${info.width}x${info.height}`);

    const cuts = await detectScenes(srcFile);
    const segments = buildSegments(cuts, info.duration);
    log(`scene cuts: ${cuts.length}, shots: ${segments.length}`);

    // Narrative section from position in the source video.
    const total = info.duration;
    const sectionFor = (start: number, end: number): string => {
      const mid = (start + end) / 2;
      if (mid <= Math.min(5, total * 0.18)) return 'hook';
      if (mid >= total * 0.82) return 'cta';
      return 'body';
    };

    for (let i = 0; i < segments.length; i++) {
      const [start, end] = segments[i];
      const clipFile = path.join(workDir, `shot_${i}.mp4`);
      const thumbFile = path.join(workDir, `shot_${i}.jpg`);
      try {
        await cutClip(srcFile, start, end, clipFile);
        await grabThumb(srcFile, (start + end) / 2, thumbFile);
      } catch (e) {
        log(`shot ${i} cut failed: ${(e as Error).message}`);
        continue;
      }

      const base = `${projectId}/shots/${brandId}/${adId}_${i}_${Date.now()}`;
      const clipKey = `${base}.mp4`;
      const thumbKey = `${base}.jpg`;
      await uploadFile(supabase, clipKey, clipFile, 'video/mp4');
      let storedThumb = '';
      try {
        storedThumb = await uploadFile(supabase, thumbKey, thumbFile, 'image/jpeg');
      } catch (e) {
        log(`thumb upload failed: ${(e as Error).message}`);
      }

      const meta = await analyzeShot(thumbFile);
      log(`shot ${i}: ${meta.label || '(no label)'} [${meta.tags.join(', ')}]${meta.hasText ? ' SUBS' : ''}`);

      const row: Record<string, unknown> = {
        project_id: projectId,
        brand_id: brandId,
        ad_id: adId,
        file_path: clipKey,
        thumb_path: storedThumb || null,
        start_sec: start,
        end_sec: end,
        duration_sec: +(end - start).toFixed(2),
        width: info.width,
        height: info.height,
        has_text: meta.hasText,
        text_score: meta.score,
        text_region: meta.region,
        label: meta.label || null,
        caption: meta.caption || null,
        tags: meta.tags,
        section: sectionFor(start, end),
      };
      let { data: ins, error: insErr } = await supabase
        .from('competitor_shots').insert(row).select('id').maybeSingle();
      // If the new columns aren't migrated yet, retry without them so we still
      // capture the shot (older schema compatibility).
      if (insErr && /label|caption|tags|section/i.test(insErr.message)) {
        delete row.label; delete row.caption; delete row.tags; delete row.section;
        ({ data: ins, error: insErr } = await supabase
          .from('competitor_shots').insert(row).select('id').maybeSingle());
      }
      if (insErr) log(`shot ${i} insert failed: ${insErr.message}`);
      else {
        shotsCount++;
        if (meta.hasText && ins?.id) subtitled.push(ins.id as number);
      }
    }

    // Burned-in subtitles lock a shot out of builds, so clean them right away
    // instead of waiting for someone to press "Remove subs".
    if (subtitled.length) {
      const queued = await autoCleanShots(supabase, selfOrigin(req.url), projectId, subtitled);
      log(queued
        ? `queued AI subtitle removal for ${queued}/${subtitled.length} subtitled shots`
        : `${subtitled.length} subtitled shots left for manual cleanup ` +
          '(REPLICATE_API_TOKEN missing or inpaint migration not applied)');
    }

    await supabase
      .from('video_segment_jobs')
      .update({ status: 'done', shots_count: shotsCount, finished_at: new Date().toISOString() })
      .eq('id', jobId);
    log(`done — ${shotsCount} shots`);
    return new Response('done', { status: 200 });
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 1000);
    log('error:', msg);
    await supabase
      .from('video_segment_jobs')
      .update({ status: 'error', error: msg, shots_count: shotsCount, finished_at: new Date().toISOString() })
      .eq('id', jobId);
    return new Response('error', { status: 200 });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
