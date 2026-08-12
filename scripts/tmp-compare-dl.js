const fs = require('fs');
const { execFileSync } = require('child_process');
const ff = require('ffmpeg-static');
const PID = '8dc8b6b3-9317-4c0e-acfd-7570e9838402';
const base = 'https://cute-cupcake-74bad8.netlify.app/api/projecthub/file-proxy?path=';
const ids = [615, 621, 670, 680];
(async () => {
  for (const id of ids) {
    const jkey = `${PID}/shots-compare/${id}_minimax-remover.json`;
    const mkey = `${PID}/shots-compare/${id}_minimax-remover.mp4`;
    const jr = await fetch(base + encodeURIComponent(jkey));
    if (jr.ok) {
      const j = await jr.json();
      console.log(`\n#${id}: chunked=${JSON.stringify(j.chunked||'no')} out=${JSON.stringify(j.output? {s:j.output.seconds, src:j.output.sourceSeconds, keptAll:j.output.keptAll}:j.error||'n/a')}`);
    } else console.log(`\n#${id}: report ${jr.status}`);
    const mr = await fetch(base + encodeURIComponent(mkey));
    if (mr.ok) {
      const buf = Buffer.from(await mr.arrayBuffer());
      fs.writeFileSync(`.tmp-cmp-${id}.mp4`, buf);
      execFileSync(ff, ['-y','-loglevel','error','-i',`.tmp-cmp-${id}.mp4`,
        '-vf', "select='eq(n\\,4)+eq(n\\,25)+eq(n\\,50)+eq(n\\,80)',tile=4x1",'-frames:v','1',`.tmp-cmp-${id}.png`]);
      console.log(`  output ${buf.length}b -> .tmp-cmp-${id}.png`);
    } else console.log(`  mp4 ${mr.status}`);
  }
})();
