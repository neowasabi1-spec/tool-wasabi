// One-shot fix: when Morfeo / Neo saved a generated document into the
// `back_end` TEXT column instead of `brief_files` (Frontend / Product Brief),
// move the content over. The Frontend section is the only one consumed by
// the rewrite pipeline, so anything stuck in back_end is invisible to the
// LLM until we move it.
//
// What it does:
//   1. Reads projects.back_end (TEXT) for a project (by id or name).
//   2. If non-empty, appends it as a new SectionFile to brief_files.files,
//      rebuilds brief_files.content via the same shape buildSectionContent
//      uses, and mirrors the result into the legacy `brief` TEXT column.
//   3. CLEARS the back_end column (sets to null) so the doc isn't stored
//      twice and so the Backend tab in projecthub goes back to empty.
//
// Usage:
//   node scripts/move-backend-to-frontend.js <projectId>
//   node scripts/move-backend-to-frontend.js "NeuroFlush"   # name search
//   node scripts/move-backend-to-frontend.js "NeuroFlush" --dry-run
//   node scripts/move-backend-to-frontend.js "NeuroFlush" --name "Backend Brief V1.md"
//
// Safety:
//   - dry-run by default for name search to avoid surprises on multi-match.
//   - skips projects where back_end is empty / already a JSONB blob (the
//     migration only needs to run on TEXT raw rows).
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

// Local copy of buildSectionContent — keep in sync with src/lib/project-sections.ts.
function buildSectionContent(files, notes) {
  const parts = [];
  for (const f of files) {
    if (!f?.content?.trim()) continue;
    parts.push(`=== FILE: ${f.name} ===\n\n${f.content.trim()}`);
  }
  if (notes?.trim()) parts.push(`=== NOTES ===\n\n${notes.trim()}`);
  return parts.join('\n\n').trim();
}

function parseSectionData(val) {
  if (val == null || val === '') return { files: [], notes: '', content: '' };
  if (typeof val === 'string') return { files: [], notes: val, content: val };
  if (typeof val === 'object') {
    const obj = val;
    const files = Array.isArray(obj.files) ? obj.files.filter(Boolean) : [];
    const notes = typeof obj.notes === 'string' ? obj.notes : '';
    const content = typeof obj.content === 'string'
      ? obj.content
      : buildSectionContent(files, notes);
    return { files, notes, content };
  }
  return { files: [], notes: '', content: '' };
}

async function moveOne(project, { dryRun, fileName }) {
  const id = project.id;
  const tag = `[${project.name} ${id.slice(0, 8)}]`;

  const backRaw = project.back_end;
  if (backRaw == null || backRaw === '' || (typeof backRaw === 'object' && (!Array.isArray(backRaw.files) || backRaw.files.length === 0) && !backRaw.content)) {
    console.log(`${tag} back_end empty — skip`);
    return { skipped: true };
  }

  let backText = '';
  if (typeof backRaw === 'string') {
    backText = backRaw;
  } else if (typeof backRaw === 'object' && backRaw) {
    if (typeof backRaw.content === 'string' && backRaw.content.trim()) backText = backRaw.content;
    else if (Array.isArray(backRaw.files) && backRaw.files.length) {
      backText = backRaw.files.map((f) => `=== FILE: ${f.name} ===\n\n${(f.content || '').trim()}`).join('\n\n');
    }
  }
  if (!backText || !backText.trim()) {
    console.log(`${tag} back_end blob present but empty content — skip`);
    return { skipped: true };
  }

  const briefData = parseSectionData(project.brief_files);
  const newFile = {
    name: fileName || 'Backend Brief (migrated from back_end).md',
    content: backText.trim(),
    size: backText.trim().length,
    type: 'text/markdown',
    uploadedAt: new Date().toISOString(),
  };
  const nextFiles = [...briefData.files, newFile];
  const nextContent = buildSectionContent(nextFiles, briefData.notes);

  console.log(`${tag} will move ${backText.trim().length.toLocaleString()} chars from back_end → brief_files`);
  console.log(`${tag}   new file: "${newFile.name}"`);
  console.log(`${tag}   brief_files.files: ${briefData.files.length} → ${nextFiles.length}`);
  console.log(`${tag}   brief_files.content: ${briefData.content.length.toLocaleString()} → ${nextContent.length.toLocaleString()} chars`);

  if (dryRun) {
    console.log(`${tag} DRY RUN — no DB write`);
    return { dry: true };
  }

  const { error } = await sb
    .from('projects')
    .update({
      brief_files: { files: nextFiles, notes: briefData.notes, content: nextContent },
      brief: nextContent, // mirror for back-compat (load-knowledge fallback)
      back_end: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    console.error(`${tag} UPDATE FAILED:`, error.message);
    return { error: error.message };
  }
  console.log(`${tag} OK — back_end cleared, frontend now has ${nextFiles.length} files`);
  return { ok: true };
}

(async () => {
  const args = process.argv.slice(2);
  const arg = args[0];
  if (!arg) {
    console.error('usage: node scripts/move-backend-to-frontend.js <projectId|name> [--dry-run] [--name "<file>.md"]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const nameIdx = args.indexOf('--name');
  const fileName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

  let query = sb
    .from('projects')
    .select('id, name, brief, brief_files, back_end');
  if (/^[0-9a-f-]{36}$/i.test(arg)) query = query.eq('id', arg);
  else query = query.ilike('name', `%${arg}%`);

  const { data, error } = await query;
  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length === 0) { console.log('no project matched'); return; }

  console.log(`found ${data.length} project(s)`);
  for (const row of data) {
    await moveOne(row, { dryRun, fileName });
  }
  console.log('done.');
})();
