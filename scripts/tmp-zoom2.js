/* Zoom on the caption band across consecutive frames: original on top, rebuilt
 * below, to spot ghosting or smearing the whole-frame sheet hides.
 *   node scripts/tmp-zoom2.js <orig> <rebuilt> <startFrame> <out.png>
 */
const path = require('path');
const { spawn } = require('child_process');
const FFMPEG = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const [a, b, startArg, out] = process.argv.slice(2);
const s = Number(startArg) || 0;
const sel = `select='${[0, 1, 2, 3].map((i) => `eq(n\\,${s + i})`).join('+')}'`;
const crop = 'crop=iw:ih*0.30:0:ih*0.30';
const args = ['-y', '-i', a, '-i', b, '-filter_complex',
  `[0:v]${sel},${crop},scale=440:-1,tile=4x1[t];[1:v]${sel},${crop},scale=440:-1,tile=4x1[c];[t][c]vstack`,
  '-frames:v', '1', out];
const p = spawn(FFMPEG, args);
let err = '';
p.stderr.on('data', (d) => (err += d.toString()));
p.on('close', (code) => {
  if (code !== 0) console.log(err.split(/\r?\n/).slice(-6).join('\n'));
  else console.log('wrote', out);
});
