// Inspect a project's section blobs (brief_files, market_research, back_end,
// compliance_funnel, funnel) — how many SectionFile entries each has, total
// chars, and what the rewrite pipeline would actually pass to the LLM.
//
// Usage:
//   node scripts/inspect-project-sections.js                     # lists last 10 projects
//   node scripts/inspect-project-sections.js <projectId>         # detail of one
//   node scripts/inspect-project-sections.js "NeuroFlush"        # name search
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://sktpbizpckxldhxzezws.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI',
);

function describeSection(label, raw) {
  if (raw == null) return `${label}: <null>`;
  if (typeof raw === 'string') {
    return `${label}: TEXT (${raw.length} chars)`;
  }
  if (typeof raw === 'object') {
    const files = Array.isArray(raw.files) ? raw.files : [];
    const notes = typeof raw.notes === 'string' ? raw.notes : '';
    const content = typeof raw.content === 'string' ? raw.content : '';
    const fileSummary = files
      .map((f, i) => `    [${i + 1}] ${f?.name ?? '?'} (${(f?.content?.length || 0).toLocaleString()} chars, ${f?.type || '?'})`)
      .join('\n');
    return [
      `${label}: JSONB blob`,
      `  files: ${files.length}`,
      files.length ? fileSummary : null,
      notes ? `  notes: ${notes.length} chars` : null,
      content ? `  content (aggregated): ${content.length.toLocaleString()} chars` : '  content: <empty>',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return `${label}: unknown type ${typeof raw}`;
}

(async () => {
  const arg = process.argv[2];

  if (!arg) {
    const { data, error } = await sb
      .from('projects')
      .select('id, name, updated_at')
      .order('updated_at', { ascending: false })
      .limit(10);
    if (error) { console.error(error); process.exit(1); }
    console.log('Last 10 projects:');
    for (const p of data || []) {
      console.log(`  ${p.id}  ${p.name}  (${p.updated_at})`);
    }
    return;
  }

  let query = sb
    .from('projects')
    .select(
      'id, name, brief, brief_files, market_research, back_end, compliance_funnel, funnel, updated_at',
    );

  if (/^[0-9a-f-]{36}$/i.test(arg)) {
    query = query.eq('id', arg);
  } else {
    query = query.ilike('name', `%${arg}%`).order('updated_at', { ascending: false }).limit(5);
  }

  const { data, error } = await query;
  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length === 0) {
    console.log('No project found.');
    return;
  }

  for (const row of data) {
    console.log('═'.repeat(78));
    console.log(`Project: ${row.name}  (${row.id})`);
    console.log(`Updated: ${row.updated_at}`);
    console.log('─'.repeat(78));
    console.log(describeSection('brief (TEXT column)',
      typeof row.brief === 'string' ? row.brief : null));
    console.log(describeSection('brief_files', row.brief_files));
    console.log(describeSection('market_research', row.market_research));
    console.log(describeSection('back_end', row.back_end));
    console.log(describeSection('compliance_funnel', row.compliance_funnel));
    console.log(describeSection('funnel', row.funnel));
    console.log('─'.repeat(78));

    function extractedContent(raw) {
      if (!raw) return '';
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'object' && typeof raw.content === 'string') return raw.content;
      return '';
    }
    const briefForLLM = extractedContent(row.brief_files) || (row.brief || '');
    const mrForLLM = extractedContent(row.market_research);
    console.log(
      `WHAT THE REWRITE LLM SEES (Brief + Market Research only):\n` +
        `  brief:           ${briefForLLM.length.toLocaleString()} chars   ` +
        `(${(Array.isArray(row.brief_files?.files) ? row.brief_files.files.length : 0)} files)\n` +
        `  market_research: ${mrForLLM.length.toLocaleString()} chars   ` +
        `(${(Array.isArray(row.market_research?.files) ? row.market_research.files.length : 0)} files)`,
    );
    console.log('═'.repeat(78));
    console.log();
  }
})();
