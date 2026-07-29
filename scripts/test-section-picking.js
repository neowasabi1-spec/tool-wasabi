/* Check the section-aware footage choice against real data: the project's
 * usable shots (with their hook/body/cta section and tags) and the scenes of a
 * real build job. Prints what each scene would get and asserts hooks open the
 * video and CTAs close it.
 *   node scripts/test-section-picking.js [buildJobId]
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

// Pull the picking helpers straight out of the shared module so the test can't
// drift from what the build actually runs.
const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_shared', 'video.ts'), 'utf8');
const snippet = src.slice(src.indexOf('function tokenize('), src.indexOf('// Assemble one scene'))
  + '\nmodule.exports = { pickShotsForScene, sectionForScene };';
const js = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { pickShotsForScene, sectionForScene } = mod.exports;

(async () => {
  const s = createClient(URL, KEY, { auth: { persistSession: false } });
  const jobId = Number(process.argv[2]) || null;

  let jq = s.from('video_build_jobs').select('id, project_id, scenes').order('id', { ascending: false }).limit(1);
  if (jobId) jq = s.from('video_build_jobs').select('id, project_id, scenes').eq('id', jobId);
  const { data: jobs } = await jq;
  const job = (jobs || [])[0];
  if (!job) return console.log('no build job found');

  const scenes = (Array.isArray(job.scenes) ? job.scenes : [])
    .map((x) => (x && typeof x.text === 'string' ? x.text.trim() : ''))
    .filter(Boolean);
  console.log(`job #${job.id}: ${scenes.length} scenes`);

  const { data: rows } = await s
    .from('competitor_shots')
    .select('id, has_text, clean_path, section, tags, caption, duration_sec')
    .eq('project_id', job.project_id)
    .limit(120);

  // Same usability rule as the build: cleaned copy, or never had subtitles.
  const pool = (rows || [])
    .filter((r) => r.clean_path || r.has_text !== true)
    .map((r) => ({
      key: `shot${r.id}`,
      dur: r.duration_sec || 1.5,
      tags: Array.isArray(r.tags) ? r.tags : [],
      caption: r.caption || '',
      section: r.section || 'body',
    }));
  const count = (sec) => pool.filter((p) => p.section === sec).length;
  console.log(`pool ${pool.length} shots — hook ${count('hook')}, body ${count('body')}, cta ${count('cta')}`);
  if (!pool.length) return console.log('nothing usable yet — run the subtitle cleanup first');

  const used = new Set();
  const got = [];
  for (let i = 0; i < scenes.length; i++) {
    const want = sectionForScene(i, scenes.length);
    const dur = 4.4;
    const picked = pickShotsForScene(pool, used, scenes[i], dur, want);
    got.push({ want, sections: picked.sections });
    console.log(`  scene ${String(i + 1).padStart(2)} want ${want.padEnd(4)} got ${picked.sections.join('+') || 'NONE'}` +
      `  ${picked.dur.toFixed(1)}s/${dur}s  [${picked.clips.map((c) => c.key).join(' ')}]  "${scenes[i].slice(0, 48)}"`);
  }

  // Hooks must open and CTAs must close whenever that footage exists.
  const first = got[0];
  const last = got[got.length - 1];
  const problems = [];
  if (count('hook') && !first.sections.includes('hook')) problems.push('first scene is not hook footage');
  if (count('cta') && !last.sections.includes('cta')) problems.push('last scene is not cta footage');
  for (const [i, g] of got.entries()) {
    // A scene may fall back when its section runs out, but never to the section
    // reserved for the opposite end of the video.
    const wrongEnd = g.want === 'hook' ? 'cta' : g.want === 'cta' ? 'hook' : null;
    if (wrongEnd && count(g.want) && g.sections.includes(wrongEnd)) {
      problems.push(`scene ${i + 1} wanted ${g.want} but got ${wrongEnd} footage while ${g.want} clips were free`);
    }
  }
  console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nOK — hook opens, cta closes, no cross-end mixing');
  process.exit(problems.length ? 1 : 0);
})();
