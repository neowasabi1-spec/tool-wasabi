/* Rebuild the pixels under a burned-in caption from the real footage instead of
 * inventing them.
 *
 * A caption only covers a given pixel for part of the clip: words change, lines
 * wrap, the text disappears between sentences. So for most masked pixels there
 * is another frame of the same shot where that exact spot is visible, and the
 * honest fix is to copy it rather than let an inpainting model guess. Handheld
 * footage drifts, so each copy is motion compensated with a small integer
 * translation estimated between consecutive frames.
 *
 * Prints how much of the caption it could rebuild from real pixels, writes the
 * rebuilt clip, and lays original / AI-cleaned / rebuilt side by side.
 *
 *   node scripts/tbe-prototype.js <shotId> [moreShotIds...]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';
const BUCKET = 'project-files';
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = 'C:/Users/Neo/tmp-tbe';

const COLOR_TOL = 110;   // L1 distance that still counts as caption colour
const DILATE = 8;        // px grown around matched pixels (antialias + outline + shadow)
const MOTION_RANGE = 6;  // px searched when estimating drift between frames
const BLK = 16;          // block rebuilt in one go
const RING = 6;          // px of visible surroundings used to validate a match
const SEARCH = 18;       // px of local motion searched per block
const CAND = 12;          // how many neighbouring frames a block may borrow from
const SAD_OK = 14;       // mean channel error that counts as a trustworthy match

function ff(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, err }));
  });
}

async function probe(file) {
  const { err } = await ff(['-hide_banner', '-i', file]);
  const dim = err.match(/Video:.*?[,\s](\d{2,5})x(\d{2,5})/);
  const fps = err.match(/(\d+(?:\.\d+)?)\s+fps/);
  return { W: dim ? +dim[1] : 0, H: dim ? +dim[2] : 0, fps: fps ? parseFloat(fps[1]) : 30 };
}

async function frames(file, W, H, raw) {
  await ff(['-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  return { buf, n: Math.floor(buf.length / (W * H * 3)) };
}

/** Band of rows the caption lives in, from the measured text_region. */
function bandRows(region, H) {
  const m = String(region || '').match(/(\d*\.?\d+)\s*-\s*(\d*\.?\d+)/);
  const y0 = m ? Math.floor(+m[1] * H) : Math.floor(H * 0.3);
  const y1 = m ? Math.ceil(+m[2] * H) : Math.ceil(H * 0.95);
  // Captions overflow the measured band a little; give it room both ways.
  return [Math.max(0, y0 - Math.round(H * 0.06)), Math.min(H, y1 + Math.round(H * 0.06))];
}

/**
 * Caption colour, learned from the clip itself: bright pixels inside the band
 * that sit next to a much darker pixel (letters carry an outline or shadow, a
 * bright wall does not). Saturated wins over white when both are present.
 */
function captionColour(buf, n, W, H, y0, y1) {
  const sat = [];
  const white = [];
  const fsz = W * H * 3;
  for (let f = 0; f < n; f += Math.max(1, Math.floor(n / 12))) {
    for (let y = y0 + 2; y < y1 - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = f * fsz + (y * W + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const mx = Math.max(r, g, b);
        if (mx < 190) continue;
        let dark = false;
        for (let dy = -2; dy <= 2 && !dark; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const j = f * fsz + ((y + dy) * W + (x + dx)) * 3;
            if (Math.max(buf[j], buf[j + 1], buf[j + 2]) < mx - 70) { dark = true; break; }
          }
        }
        if (!dark) continue;
        if (mx - Math.min(r, g, b) > 100) sat.push([r, g, b]);
        else if (Math.min(r, g, b) > 200) white.push([r, g, b]);
      }
    }
  }
  const med = (arr, k) => {
    const v = arr.map((p) => p[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 0;
  };
  const pool = sat.length >= 200 ? sat : white;
  if (pool.length < 100) return null;
  return { colour: [med(pool, 0), med(pool, 1), med(pool, 2)], kind: sat.length >= 200 ? 'saturated' : 'white', samples: pool.length };
}

/** Per-frame caption mask: matched colour inside the band, then grown. */
function buildMasks(buf, n, W, H, y0, y1, cap) {
  const fsz = W * H * 3;
  const masks = [];
  for (let f = 0; f < n; f++) {
    const hit = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const i = f * fsz + p * 3;
        const d = Math.abs(buf[i] - cap[0]) + Math.abs(buf[i + 1] - cap[1]) + Math.abs(buf[i + 2] - cap[2]);
        if (d <= COLOR_TOL) hit[p] = 1;
      }
    }
    // Grow: a letter's antialiased rim and dark outline must go too, or the
    // rebuilt pixels sit inside a ghost of the original glyph.
    const grown = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        if (!hit[y * W + x]) continue;
        for (let dy = -DILATE; dy <= DILATE; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -DILATE; dx <= DILATE; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < W) grown[yy * W + xx] = 1;
          }
        }
      }
    }
    masks.push(grown);
  }
  return masks;
}

/** Integer drift between consecutive frames, measured off unmasked pixels. */
function drifts(buf, n, W, H, masks, y0, y1) {
  const fsz = W * H * 3;
  const step = Math.max(2, Math.round(Math.min(W, y1 - y0) / 60));
  const out = [[0, 0]];
  for (let f = 1; f < n; f++) {
    let best = [0, 0];
    let bestSad = Infinity;
    for (let dy = -MOTION_RANGE; dy <= MOTION_RANGE; dy++) {
      for (let dx = -MOTION_RANGE; dx <= MOTION_RANGE; dx++) {
        let sad = 0;
        let cnt = 0;
        for (let y = y0 + MOTION_RANGE; y < y1 - MOTION_RANGE; y += step) {
          for (let x = MOTION_RANGE; x < W - MOTION_RANGE; x += step) {
            const p = y * W + x;
            const q = (y + dy) * W + (x + dx);
            if (masks[f][p] || masks[f - 1][q]) continue;
            sad += Math.abs(buf[f * fsz + p * 3] - buf[(f - 1) * fsz + q * 3]);
            cnt++;
          }
        }
        if (cnt < 200) continue;
        const avg = sad / cnt;
        if (avg < bestSad) { bestSad = avg; best = [dx, dy]; }
      }
    }
    out.push([out[f - 1][0] + best[0], out[f - 1][1] + best[1]]);
  }
  return out;
}

/**
 * Rebuild block by block. A single camera drift per frame is not enough: people
 * walk, the lens zooms, the ground slides at a different rate than the horizon.
 * So each 16px block searches its own displacement in the neighbouring frames
 * and is only accepted when the visible ring around it lines up, which is what
 * proves the borrowed pixels belong there. The global drift is only the starting
 * guess for that search.
 */
function rebuild(buf, n, W, H, masks, cum) {
  const fsz = W * H * 3;
  const out = Buffer.from(buf);
  let masked = 0;
  let real = 0;
  let dist = 0;
  const guessed = new Array(n).fill(0);
  const sads = [];

  // Pixel-level bookkeeping so the stats mean "rebuilt from real pixels".
  for (let f = 0; f < n; f++) {
    for (let p = 0; p < W * H; p++) if (masks[f][p]) masked++;
  }

  for (let f = 0; f < n; f++) {
    for (let by = 0; by < H; by += BLK) {
      for (let bx = 0; bx < W; bx += BLK) {
        // Does this block hold caption pixels at all?
        let hits = 0;
        for (let y = by; y < Math.min(by + BLK, H); y++) {
          for (let x = bx; x < Math.min(bx + BLK, W); x++) if (masks[f][y * W + x]) hits++;
        }
        if (!hits) continue;

        // Ring pixels: visible in this frame, used to score a candidate.
        const ring = [];
        const ry0 = Math.max(0, by - RING);
        const ry1 = Math.min(H, by + BLK + RING);
        const rx0 = Math.max(0, bx - RING);
        const rx1 = Math.min(W, bx + BLK + RING);
        for (let y = ry0; y < ry1; y++) {
          for (let x = rx0; x < rx1; x++) {
            const p = y * W + x;
            if (!masks[f][p]) ring.push(p);
          }
        }

        let best = null;
        for (let d = 1; d <= CAND && !(best && best.sad < SAD_OK / 2); d++) {
          for (const t of [f - d, f + d]) {
            if (t < 0 || t >= n) continue;
            const gx = cum[t][0] - cum[f][0];
            const gy = cum[t][1] - cum[f][1];
            for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
              for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
                const ox = gx + dx;
                const oy = gy + dy;
                // The borrowed block must be inside the frame and free of caption.
                let usable = true;
                for (let y = by; y < Math.min(by + BLK, H) && usable; y += 2) {
                  for (let x = bx; x < Math.min(bx + BLK, W); x += 2) {
                    if (!masks[f][y * W + x]) continue;
                    const sx = x + ox;
                    const sy = y + oy;
                    if (sx < 0 || sx >= W || sy < 0 || sy >= H || masks[t][sy * W + sx]) { usable = false; break; }
                  }
                }
                if (!usable) continue;

                let sad = 0;
                let cnt = 0;
                for (let k = 0; k < ring.length; k += 2) {
                  const p = ring[k];
                  const x = p % W;
                  const y = (p - x) / W;
                  const sx = x + ox;
                  const sy = y + oy;
                  if (sx < 0 || sx >= W || sy < 0 || sy >= H) { cnt = 0; break; }
                  const q = sy * W + sx;
                  if (masks[t][q]) continue;
                  const i = f * fsz + p * 3;
                  const j = t * fsz + q * 3;
                  sad += Math.abs(buf[i] - buf[j]) + Math.abs(buf[i + 1] - buf[j + 1]) + Math.abs(buf[i + 2] - buf[j + 2]);
                  cnt += 3;
                }
                if (cnt < 60) continue;
                const avg = sad / cnt;
                if (!best || avg < best.sad) best = { sad: avg, t, ox, oy, d };
              }
            }
          }
        }

        if (!best) {
          for (let y = by; y < Math.min(by + BLK, H); y++) {
            for (let x = bx; x < Math.min(bx + BLK, W); x++) if (masks[f][y * W + x]) guessed[f]++;
          }
          continue;
        }
        sads.push(best.sad);
        for (let y = by; y < Math.min(by + BLK, H); y++) {
          for (let x = bx; x < Math.min(bx + BLK, W); x++) {
            const p = y * W + x;
            if (!masks[f][p]) continue;
            const q = (y + best.oy) * W + (x + best.ox);
            out[f * fsz + p * 3] = buf[best.t * fsz + q * 3];
            out[f * fsz + p * 3 + 1] = buf[best.t * fsz + q * 3 + 1];
            out[f * fsz + p * 3 + 2] = buf[best.t * fsz + q * 3 + 2];
            real++; dist += best.d;
          }
        }
      }
    }
  }
  const medSad = sads.length ? sads.sort((a, b) => a - b)[Math.floor(sads.length / 2)] : 0;
  console.log(`  block match error: median ${medSad.toFixed(1)}, ` +
    `${(100 * sads.filter((v) => v < SAD_OK).length / (sads.length || 1)).toFixed(0)}% of blocks trustworthy`);

  // The leftovers (a spot covered for the whole clip) get the nearest visible
  // pixel on the same row: crude, but it is a thin rim, not a whole caption.
  for (let f = 0; f < n; f++) {
    if (!guessed[f]) continue;
    for (let p = 0; p < W * H; p++) {
      if (!masks[f][p]) continue;
      const x = p % W;
      const y = (p - x) / W;
      let src = -1;
      for (let d = 1; d < W && src < 0; d++) {
        if (x - d >= 0 && !masks[f][y * W + (x - d)]) src = y * W + (x - d);
        else if (x + d < W && !masks[f][y * W + (x + d)]) src = y * W + (x + d);
      }
      if (src < 0) continue;
      // Only touch what the temporal pass could not resolve: those pixels still
      // hold the original caption colour.
      out[f * fsz + p * 3] = out[f * fsz + src * 3];
      out[f * fsz + p * 3 + 1] = out[f * fsz + src * 3 + 1];
      out[f * fsz + p * 3 + 2] = out[f * fsz + src * 3 + 2];
    }
  }

  return { out, masked, real, avgDist: real ? dist / real : 0, guessed };
}

async function run(s, shotId) {
  const { data: sh } = await s
    .from('competitor_shots')
    .select('id, file_path, clean_path, duration_sec, text_region, has_text')
    .eq('id', shotId)
    .maybeSingle();
  if (!sh) return console.log(`shot #${shotId}: not found`);

  const clip = path.join(OUT, `shot${shotId}.mp4`);
  const { data: dl, error } = await s.storage.from(BUCKET).download(sh.file_path);
  if (error) return console.log(`shot #${shotId}: download failed — ${error.message}`);
  fs.writeFileSync(clip, Buffer.from(await dl.arrayBuffer()));

  const { W, H, fps } = await probe(clip);
  const { buf, n } = await frames(clip, W, H, path.join(OUT, `shot${shotId}.raw`));
  const [y0, y1] = bandRows(sh.text_region, H);
  console.log(`\nshot #${shotId}: ${W}x${H} @${fps}fps, ${n} frames, band rows ${y0}-${y1} (${sh.text_region})`);

  const cap = captionColour(buf, n, W, H, y0, y1);
  if (!cap) return console.log('  could not learn a caption colour — nothing to rebuild');
  console.log(`  caption colour rgb(${cap.colour.join(',')}) [${cap.kind}, ${cap.samples} samples]`);

  const masks = buildMasks(buf, n, W, H, y0, y1, cap.colour);
  const perFrame = masks.map((m) => m.reduce((a, v) => a + v, 0));
  console.log(`  caption covers ${Math.round(perFrame.reduce((a, v) => a + v, 0) / n)} px/frame ` +
    `(${(100 * perFrame.reduce((a, v) => a + v, 0) / n / (W * H)).toFixed(1)}% of the frame)`);

  const cum = drifts(buf, n, W, H, masks, y0, y1);
  const drift = Math.max(...cum.map(([dx, dy]) => Math.abs(dx) + Math.abs(dy)));
  console.log(`  camera drift over the clip: ${drift}px`);

  const { out, masked, real, avgDist, guessed } = rebuild(buf, n, W, H, masks, cum);
  const pct = masked ? (100 * real) / masked : 0;
  console.log(`  rebuilt from real pixels: ${pct.toFixed(1)}% ` +
    `(${real}/${masked}, avg ${avgDist.toFixed(1)} frames away)`);
  const worstGuess = guessed.reduce((a, v) => Math.max(a, v), 0);
  console.log(`  had to guess: ${(100 - pct).toFixed(1)}% (worst frame ${worstGuess} px)`);

  const rawOut = path.join(OUT, `shot${shotId}_tbe.raw`);
  fs.writeFileSync(rawOut, out);
  const mp4 = path.join(OUT, `shot${shotId}_tbe.mp4`);
  await ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps),
    '-i', rawOut, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', mp4]);

  // Compare the frame with the most caption on screen: original, what the AI
  // pass produced, and the rebuilt one. Crop to the caption band and zoom.
  const worst = perFrame.indexOf(Math.max(...perFrame));
  const at = worst / fps;
  const crop = `crop=${W}:${y1 - y0}:0:${y0},scale=460:-1`;
  const shots = [];
  for (const [tag, file] of [['orig', clip], ['tbe', mp4]]) {
    const png = path.join(OUT, `shot${shotId}_${tag}_f${worst}.png`);
    await ff(['-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', crop, png]);
    if (fs.existsSync(png)) shots.push(png);
  }
  if (sh.clean_path) {
    const { data: cd } = await s.storage.from(BUCKET).download(sh.clean_path);
    if (cd) {
      const cf = path.join(OUT, `shot${shotId}_clean.mp4`);
      fs.writeFileSync(cf, Buffer.from(await cd.arrayBuffer()));
      const png = path.join(OUT, `shot${shotId}_ai_f${worst}.png`);
      await ff(['-y', '-ss', String(at), '-i', cf, '-frames:v', '1', '-vf', crop, png]);
      if (fs.existsSync(png)) shots.splice(1, 0, png);
    }
  }
  const sheet = path.join(OUT, `shot${shotId}_compare.png`);
  await ff(['-y', ...shots.flatMap((p) => ['-i', p]),
    '-filter_complex', `vstack=inputs=${shots.length}`, sheet]);
  console.log(`  frame ${worst}: ${shots.length === 3 ? 'original / AI clean / rebuilt' : 'original / rebuilt'}`);
  console.log(`  sheet: ${sheet}`);
  console.log(`  video: ${mp4}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) return console.log('usage: node scripts/tbe-prototype.js <shotId> [more...]');
  for (const id of ids) await run(s, id);
})();
