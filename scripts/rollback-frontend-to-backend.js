// Rollback dell'operazione fatta da move-backend-to-frontend.js sul progetto
// NeuroFlush (o qualunque progetto passato come arg). Riporta lo stato del DB
// a com'era PRIMA dello spostamento back_end -> brief_files di stasera:
//
//   - rimuove il file "Backend Brief - migrated.md" (o quello indicato con
//     --name) da brief_files.files
//   - ricostruisce brief_files.content concatenando solo i file rimasti
//   - rimette il content di quel file nella colonna back_end (TEXT)
//   - allinea il mirror `brief` (TEXT) col nuovo content (3 file)
//
// Dry-run di default; passare --apply per scrivere.
//
// Usage:
//   node scripts/rollback-frontend-to-backend.js "NeuroFlush"
//   node scripts/rollback-frontend-to-backend.js "NeuroFlush" --apply
//   node scripts/rollback-frontend-to-backend.js <projectId> --apply --name "Backend Brief - migrated.md"
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

function buildSectionContent(files, notes) {
  const parts = [];
  for (const f of files) {
    if (!f?.content?.trim()) continue;
    parts.push(`=== FILE: ${f.name} ===\n\n${f.content.trim()}`);
  }
  if (notes?.trim()) parts.push(`=== NOTES ===\n\n${notes.trim()}`);
  return parts.join('\n\n').trim();
}

(async () => {
  const args = process.argv.slice(2);
  const arg = args[0];
  if (!arg) { console.error('usage: <projectId|name> [--apply] [--name "<file>.md"]'); process.exit(1); }
  const apply = args.includes('--apply');
  const nameIdx = args.indexOf('--name');
  const targetFileName = nameIdx >= 0 ? args[nameIdx + 1] : 'Backend Brief - migrated.md';

  let q = sb.from('projects').select('id, name, brief, brief_files, back_end');
  if (/^[0-9a-f-]{36}$/i.test(arg)) q = q.eq('id', arg);
  else q = q.ilike('name', `%${arg}%`);
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length === 0) { console.log('no project matched'); return; }

  for (const row of data) {
    const id = row.id;
    const tag = `[${row.name} ${id.slice(0, 8)}]`;
    const bf = row.brief_files;
    if (!bf || typeof bf !== 'object' || !Array.isArray(bf.files)) {
      console.log(`${tag} brief_files vuoto o malformato — skip`);
      continue;
    }
    const idx = bf.files.findIndex((f) => f && f.name === targetFileName);
    if (idx < 0) {
      console.log(`${tag} file "${targetFileName}" non trovato nei brief_files — skip`);
      continue;
    }
    const removed = bf.files[idx];
    const remainingFiles = bf.files.filter((_, i) => i !== idx);
    const notes = typeof bf.notes === 'string' ? bf.notes : '';
    const newContent = buildSectionContent(remainingFiles, notes);
    const newBackEnd = removed?.content || '';

    const oldBackEnd = row.back_end == null ? '<null>' : `${String(row.back_end).length} chars`;
    console.log(`${tag} rollback:`);
    console.log(`${tag}   removed file: "${removed.name}" (${(removed.content || '').length.toLocaleString()} chars)`);
    console.log(`${tag}   brief_files.files: ${bf.files.length} -> ${remainingFiles.length}`);
    console.log(`${tag}   brief_files.content: ${(bf.content || '').length.toLocaleString()} -> ${newContent.length.toLocaleString()}`);
    console.log(`${tag}   back_end: ${oldBackEnd} -> ${newBackEnd.length.toLocaleString()} chars (TEXT)`);
    console.log(`${tag}   brief (mirror): ${(row.brief || '').length.toLocaleString()} -> ${newContent.length.toLocaleString()}`);

    if (!apply) { console.log(`${tag} DRY RUN — passa --apply per scrivere`); continue; }

    const { error: upErr } = await sb
      .from('projects')
      .update({
        brief_files: { files: remainingFiles, notes, content: newContent },
        brief: newContent,
        back_end: newBackEnd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (upErr) { console.error(`${tag} UPDATE FAILED:`, upErr.message); continue; }
    console.log(`${tag} OK — rollback applicato`);
  }
})();
