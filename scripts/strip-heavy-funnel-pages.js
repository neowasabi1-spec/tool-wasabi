// One-off repair: funnel_pages rows written server-side (old Chimera landing
// step) kept the FULL page HTML inline in cloned_data/swiped_data JSONB.
// 6 rows ≈ 11 MB → every app boot downloaded all of it, hitting the 12s init
// timeout ("Connection Error" → looks like login is broken).
//
// For each heavy row:
//   1. mirror any inline html into page_html (kind cloned/swiped) if missing
//   2. strip html/mobileHtml from the JSONB, leaving htmlUrl + htmlSkipped +
//      htmlLength (same shape the client-side strip produces)
//
// Run: node scripts/strip-heavy-funnel-pages.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sktpbizpckxldhxzezws.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdHBiaXpwY2t4bGRoeHplendzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1NjEyNjUsImV4cCI6MjA5MjEzNzI2NX0.2fnHDXnnrwuLyXP9fqtSsJnskftf4PcNVYmigHTz1YI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const THRESHOLD = 50 * 1024; // same as HTML_STORAGE_THRESHOLD client-side

function htmlUrlFor(pageId, kind, variant) {
  return `/api/funnel-html?pageId=${encodeURIComponent(pageId)}&kind=${kind}&variant=${variant}`;
}

async function mirrorToPageHtml(pageId, kind, variant, html, ownerUserId) {
  const { error } = await sb.from('page_html').upsert(
    {
      page_id: pageId,
      kind,
      variant,
      html,
      owner_user_id: ownerUserId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'page_id,kind,variant' },
  );
  if (error) throw new Error(`page_html upsert ${pageId}/${kind}/${variant}: ${error.message}`);
}

/** Returns { blob, changed } with html/mobileHtml stripped when > THRESHOLD. */
async function slimBlob(pageId, kind, blob, ownerUserId) {
  if (!blob || typeof blob !== 'object') return { blob, changed: false };
  const out = { ...blob };
  let changed = false;

  for (const [field, variant] of [['html', 'desktop'], ['mobileHtml', 'mobile']]) {
    const val = typeof out[field] === 'string' ? out[field] : '';
    if (val.length <= THRESHOLD) continue;
    // Make sure the server copy exists BEFORE dropping the inline one.
    const check = await sb.from('page_html').select('page_id').eq('page_id', pageId).eq('kind', kind).eq('variant', variant).maybeSingle();
    if (!check.data) {
      await mirrorToPageHtml(pageId, kind, variant, val, ownerUserId);
      console.log(`  mirrored ${kind}/${variant} (${Math.round(val.length / 1024)} KB) → page_html`);
    }
    out[`${field}Length`] = val.length;
    out[`${field}Skipped`] = true;
    out[field === 'html' ? 'htmlUrl' : 'mobileHtmlUrl'] = htmlUrlFor(pageId, kind, variant);
    delete out[field];
    changed = true;
  }
  return { blob: out, changed };
}

(async () => {
  const { data: rows, error } = await sb
    .from('funnel_pages')
    .select('id, name, cloned_data, swiped_data, extracted_data');
  if (error) throw error;

  let repaired = 0;
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length;
    if (rowSize < 200 * 1024) continue;
    console.log(`${row.name} (${Math.round(rowSize / 1024)} KB)`);

    const patch = {};
    for (const [col, kind] of [['cloned_data', 'cloned'], ['swiped_data', 'swiped'], ['extracted_data', 'extracted']]) {
      const { blob, changed } = await slimBlob(row.id, kind, row[col], null);
      if (changed) patch[col] = blob;
    }
    if (!Object.keys(patch).length) { console.log('  nothing to strip'); continue; }

    const { error: updErr } = await sb.from('funnel_pages').update(patch).eq('id', row.id);
    if (updErr) { console.log(`  UPDATE FAILED: ${updErr.message}`); continue; }
    console.log(`  stripped: ${Object.keys(patch).join(', ')}`);
    repaired++;
  }
  console.log(`\nDone. ${repaired} rows repaired.`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
