import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * Public health check for the video segment/build worker.
 *
 * The worker runs in the SAME Fly container as this Next server (see start.sh)
 * and writes a heartbeat file to the OS temp dir. This endpoint reports:
 *   - whether the server has SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY,
 *   - whether the worker heartbeat is fresh (i.e. the worker is alive),
 *   - current segment/build queue counts.
 *
 * Interpreting:
 *   - hasServiceRoleKey === false → worker crash-loops + can't upload shots.
 *     Set SUPABASE_SERVICE_ROLE_KEY as a Fly secret.
 *   - worker.alive === false with pending jobs → worker isn't running.
 *   - worker.alive === true but jobs stuck pending → look at worker logs.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const out: Record<string, unknown> = {
    now: Date.now(),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasOpenAIKey: Boolean((process.env.OPENAI_API_KEY || '').trim()),
  };

  // Worker heartbeat.
  try {
    const file = path.join(os.tmpdir(), 'wasabi-video-worker.json');
    const raw = fs.readFileSync(file, 'utf8');
    const hb = JSON.parse(raw) as { ts: number; pid: number; ocr: boolean };
    const ageMs = Date.now() - hb.ts;
    out.worker = {
      alive: ageMs < 60000, // heartbeat every poll (~5s); 60s = generous
      ageMs,
      pid: hb.pid,
      ocr: hb.ocr,
    };
  } catch {
    out.worker = { alive: false, ageMs: null, note: 'no heartbeat file' };
  }

  // Queue counts.
  try {
    const seg: Record<string, number> = {};
    for (const s of ['pending', 'processing', 'done', 'error']) {
      const { count } = await supabaseAdmin
        .from('video_segment_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', s);
      seg[s] = count ?? 0;
    }
    out.segmentJobs = seg;

    const { count: shots } = await supabaseAdmin
      .from('competitor_shots')
      .select('id', { count: 'exact', head: true });
    out.shotsTotal = shots ?? 0;
  } catch (e) {
    out.queueError = e instanceof Error ? e.message : 'queue read failed';
  }

  return NextResponse.json(out);
}
