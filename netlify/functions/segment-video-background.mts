import fs from 'fs';
import path from 'path';
import {
  getSupabase, ffprobeInfo, detectScenes, buildSegments, cutClip, grabThumb,
  analyzeShot, planShotsFromVideo, downloadSource, uploadFile, makeWorkDir,
  autoCleanShots, selfOrigin, type PlannedShot,
} from './_shared/video';

/**
 * Background function (up to 15 min) that splits a competitor video into
 * individual "shots". Vision plans cuts by ACTION duration (not a 2s clock);
 * ffmpeg scene cuts are hints only. Each shot is stored with a scene JSON
 * (action, people count, context) so the builder can match footage to copy.
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
    const planned = await planShotsFromVideo(srcFile, info.duration, cuts, workDir);
    const segments: PlannedShot[] = planned && planned.length
      ? planned
      : buildSegments(cuts, info.duration).map(([start, end]) => ({
        start, end, action: '', peopleCount: 0, people: '', context: '',
        label: '', caption: '', tags: [],
      }));
    log(planned?.length
      ? `action-planned ${segments.length} shots (ffmpeg hints: ${cuts.length})`
      : `ffmpeg fallback: ${cuts.length} cuts → ${segments.length} shots`);

    // Narrative section from position in the source video.
    const total = info.duration;
    const sectionFor = (start: number, end: number): string => {
      const mid = (start + end) / 2;
      if (mid <= Math.min(5, total * 0.18)) return 'hook';
      if (mid >= total * 0.82) return 'cta';
      return 'body';
    };

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const start = seg.start;
      const end = seg.end;
      const clipFile = path.join(workDir, `shot_${i}.mp4`);
      const thumbFile = path.join(workDir, `shot_${i}.jpg`);
      const extraA = path.join(workDir, `shot_${i}_a.jpg`);
      const extraB = path.join(workDir, `shot_${i}_b.jpg`);
      try {
        await cutClip(srcFile, start, end, clipFile);
        const span = end - start;
        await grabThumb(srcFile, (start + end) / 2, thumbFile);
        if (span >= 2.2) {
          try { await grabThumb(srcFile, start + Math.min(0.35, span * 0.12), extraA, 360); } catch { /* optional */ }
          try { await grabThumb(srcFile, end - Math.min(0.35, span * 0.12), extraB, 360); } catch { /* optional */ }
        }
      } catch (e) {
        log(`shot ${i} cut failed: ${(e as Error).message}`);
        continue;
      }

      const extras = [extraA, extraB].filter((p) => {
        try { return fs.existsSync(p) && fs.statSync(p).size > 80; } catch { return false; }
      });
      const vision = await analyzeShot(thumbFile, extras);
      const action = vision.action || seg.action || '';
      const peopleCount = vision.peopleCount || seg.peopleCount || 0;
      const people = vision.people || seg.people || '';
      const context = vision.context || seg.context || '';
      const label = vision.label || seg.label || '';
      const caption = vision.caption || seg.caption || '';
      const tags = (vision.tags.length ? vision.tags : seg.tags) || [];
      log(`shot ${i}: ${action || label || '(no scene)'} [${peopleCount}p] ${context}${vision.hasText ? ' SUBS' : ''}`);

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
        has_text: vision.hasText,
        text_score: vision.score,
        text_region: vision.region,
        label: label || null,
        caption: caption || null,
        tags,
        section: sectionFor(start, end),
        action: action || null,
        people_count: peopleCount,
        people: people || null,
        context: context || null,
        scene: { action, peopleCount, people, context },
      };
      let { data: ins, error: insErr } = await supabase
        .from('competitor_shots').insert(row).select('id').maybeSingle();
      if (insErr && /action|people_count|people|context|scene/i.test(insErr.message)) {
        delete row.action; delete row.people_count; delete row.people;
        delete row.context; delete row.scene;
        ({ data: ins, error: insErr } = await supabase
          .from('competitor_shots').insert(row).select('id').maybeSingle());
      }
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
        if (vision.hasText && ins?.id) subtitled.push(ins.id as number);
      }
    }

    // Burned-in subtitles lock a shot out of builds, so clean them right away
    // instead of waiting for someone to press "Remove subs".
    if (subtitled.length) {
      const queued = await autoCleanShots(supabase, selfOrigin(req.url), projectId, subtitled);
      log(queued
        ? `queued AI subtitle removal for ${queued} subtitled shots ` +
          '(first few fired now, the rest drained by the scheduled pass)'
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
