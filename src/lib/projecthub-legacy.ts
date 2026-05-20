/**
 * Bridge between the legacy "section JSONB columns" data model
 * (market_research / brief / brief_files / front_end / back_end /
 * compliance_funnel / funnel — all stored on the `projects` row as JSONB
 * blobs of shape { files: [...], notes, content }) and the new projecthub
 * data model (rows in `project_files` keyed by `file_type` strings).
 *
 * Read-time only: nothing here mutates the DB. We synthesize virtual
 * `ProjectFile` entries with negative IDs encoding (section, index) so the
 * existing UI in `GeneralBriefSection` shows legacy uploads alongside any
 * new ones, without duplicating data.
 */

import { parseSectionData, type SectionFile } from './project-sections';

/** Legacy → projecthub file_type mapping. The General Brief tab in projecthub
 *  expects these file_type strings: market_research, ugc, pb_<section_id>,
 *  img_pb_<section_id>. Everything except market_research is treated as a
 *  Product Brief tab; ids are auto-derived in `derivedProductBriefSections`. */
const SECTION_TO_FILE_TYPE: Record<string, string> = {
  market_research: 'market_research',
  brief_files: 'pb_frontend',
  front_end: 'pb_frontend',
  back_end: 'pb_backend',
  compliance_funnel: 'pb_compliance',
  funnel: 'pb_funnel',
};

/** Stable per-section base offset for negative virtual IDs. The exact
 *  numbers don't matter as long as they're stable and don't collide with
 *  real BIGSERIAL ids (which are positive). */
const SECTION_ID_BASE: Record<string, number> = {
  market_research: -100_000,
  brief_files: -200_000,
  front_end: -300_000,
  back_end: -400_000,
  compliance_funnel: -500_000,
  funnel: -600_000,
};

const LEGACY_SECTIONS = [
  'market_research',
  'brief_files',
  'front_end',
  'back_end',
  'compliance_funnel',
  'funnel',
] as const;

export type LegacySection = (typeof LEGACY_SECTIONS)[number];

export interface VirtualProjectFile {
  id: number;
  project_id: string;
  file_type: string;
  file_path: string;
  original_name: string;
  created_at: string;
  legacy?: true;
  legacy_section?: LegacySection;
  legacy_index?: number;
  legacy_size?: number;
  legacy_content_type?: string;
}

/** Encode a legacy file location (section, index) into a stable negative
 *  integer id so the existing UI's `id: number` typing keeps working. */
export function encodeLegacyFileId(section: LegacySection, idx: number): number {
  return (SECTION_ID_BASE[section] ?? -999_000) - idx;
}

/** Inverse of `encodeLegacyFileId` — decode a virtual id back into
 *  (section, index) for delete/download endpoints. Returns null if the id
 *  doesn't fall inside any known legacy range. */
export function decodeLegacyFileId(
  id: number,
): { section: LegacySection; idx: number } | null {
  if (!Number.isFinite(id) || id >= 0) return null;
  for (const section of LEGACY_SECTIONS) {
    const base = SECTION_ID_BASE[section];
    if (id <= base && id > base - 100_000) {
      const idx = base - id;
      return { section, idx };
    }
  }
  return null;
}

/** Build a synthetic file_path for a legacy entry. Resolved by
 *  `getUploadUrl` in `projecthub-storage.ts` to a `/api/projecthub/legacy-files/...`
 *  download URL instead of going to Supabase Storage. */
function legacyFilePath(
  projectId: string,
  section: LegacySection,
  idx: number,
): string {
  return `legacy/${projectId}/${section}/${idx}`;
}

/** Read every legacy section column on a project row and produce virtual
 *  `ProjectFile` entries that can be merged into the real `files` array.
 *
 *  Two synthesis paths:
 *    A) section has a `.files[]` array      → one virtual entry per file
 *    B) section is empty/no files but has content  → one synthetic entry
 *       called `<section>.txt` so the user can still see and download
 *       legacy text that was uploaded before the section-files migration.
 *
 *  Path B also runs against the `brief` TEXT column (which is just a
 *  string, never had a `.files[]` shape), surfacing it as `pb_frontend`. */
export function legacyFilesForProject(
  project: Record<string, unknown>,
): VirtualProjectFile[] {
  const projectId = String(project.id);
  const out: VirtualProjectFile[] = [];

  for (const section of LEGACY_SECTIONS) {
    const raw = project[section];
    if (raw == null) continue;
    const data = parseSectionData(raw);

    if (data.files.length > 0) {
      data.files.forEach((f, idx) => {
        out.push({
          id: encodeLegacyFileId(section, idx),
          project_id: projectId,
          file_type: SECTION_TO_FILE_TYPE[section] || section,
          file_path: legacyFilePath(projectId, section, idx),
          original_name: f.name || `${section}_${idx + 1}.txt`,
          created_at: f.uploadedAt || (project.created_at as string) || new Date().toISOString(),
          legacy: true,
          legacy_section: section,
          legacy_index: idx,
          legacy_size: f.size,
          legacy_content_type: f.type,
        });
      });
    } else if ((data.content || data.notes || '').trim().length > 0) {
      // Path B: surface inline text as a single virtual `.txt` entry.
      out.push({
        id: encodeLegacyFileId(section, 0),
        project_id: projectId,
        file_type: SECTION_TO_FILE_TYPE[section] || section,
        file_path: legacyFilePath(projectId, section, 0),
        original_name: `${section}.txt`,
        created_at: (project.created_at as string) || new Date().toISOString(),
        legacy: true,
        legacy_section: section,
        legacy_index: 0,
        legacy_size: (data.content || data.notes || '').length,
        legacy_content_type: 'text/plain',
      });
    }
  }

  // Special case: the `brief` TEXT column is separate from `brief_files`.
  // If the user's project predates the brief_files migration their brief
  // content lives in this string column instead of any JSONB section.
  const briefText =
    typeof project.brief === 'string' ? (project.brief as string) : '';
  const alreadyHasFrontend = out.some(
    (f) => f.legacy_section === 'brief_files' || f.legacy_section === 'front_end',
  );
  if (!alreadyHasFrontend && briefText.trim().length > 0) {
    out.push({
      id: encodeLegacyFileId('brief_files', 0),
      project_id: projectId,
      file_type: 'pb_frontend',
      file_path: legacyFilePath(projectId, 'brief_files', 0),
      original_name: 'brief.txt',
      created_at: (project.created_at as string) || new Date().toISOString(),
      legacy: true,
      legacy_section: 'brief_files',
      legacy_index: 0,
      legacy_size: briefText.length,
      legacy_content_type: 'text/plain',
    });
  }

  return out;
}

/** Compute the union of:
 *   - sections explicitly persisted on the project (`product_brief_sections` JSON)
 *   - sections we can derive from non-empty legacy columns
 *
 *  Always guarantees a `pb_frontend` (Frontend) tab since the General Brief
 *  UI ships it as the default. Order is preserved: stored first (user's
 *  preferred order/labels), then any extras that aren't already covered. */
export function derivedProductBriefSections(
  project: Record<string, unknown>,
): { id: string; label: string }[] {
  let stored: { id: string; label: string }[] = [{ id: 'pb_frontend', label: 'Frontend' }];
  const raw = project.product_brief_sections;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        stored = parsed
          .filter((s) => s && typeof s === 'object' && typeof s.id === 'string')
          .map((s) => ({ id: String(s.id), label: String(s.label || s.id) }));
      }
    } catch {
      /* fall through to default */
    }
  }

  const sectionHasContent = (section: LegacySection): boolean => {
    const data = parseSectionData(project[section]);
    return (
      data.files.length > 0 ||
      (data.content || '').trim().length > 0 ||
      (data.notes || '').trim().length > 0
    );
  };

  const derived: { id: string; label: string }[] = [{ id: 'pb_frontend', label: 'Frontend' }];
  if (sectionHasContent('back_end')) derived.push({ id: 'pb_backend', label: 'Backend' });
  if (sectionHasContent('compliance_funnel')) derived.push({ id: 'pb_compliance', label: 'Compliance' });
  if (sectionHasContent('funnel')) derived.push({ id: 'pb_funnel', label: 'Funnel' });

  const seen = new Set(stored.map((s) => s.id));
  for (const d of derived) {
    if (!seen.has(d.id)) {
      stored.push(d);
      seen.add(d.id);
    }
  }
  return stored;
}

/** Helper used by the DELETE legacy-file endpoint: produce the JSONB
 *  payload to write back after removing one file at the given index. */
export function removeFileFromLegacySection(
  raw: unknown,
  idx: number,
): unknown {
  const data = parseSectionData(raw);
  const newFiles: SectionFile[] = data.files.filter((_, i) => i !== idx);
  // Mirror the same shape that supabase-migration-projects-section-files.sql
  // documents so the rewrite pipeline keeps reading our content correctly.
  const content = newFiles
    .map((f) => `\n=== FILE: ${f.name} ===\n\n${f.content || ''}`)
    .join('')
    .trim();
  return {
    files: newFiles,
    notes: data.notes,
    content: content || data.notes || '',
  };
}

/** Resolve a virtual file_path back to the underlying SectionFile (with
 *  inline text content) for serving downloads. Falls back to the section's
 *  concatenated `.content` (or the raw `brief` TEXT column for
 *  `brief_files`) when there's no per-file entry at that index — matching
 *  the synthesis logic in `legacyFilesForProject`. */
export function resolveLegacyFile(
  project: Record<string, unknown>,
  section: LegacySection,
  idx: number,
): SectionFile | null {
  const raw = project[section];
  const data = raw == null ? { files: [], notes: '', content: '' } : parseSectionData(raw);

  const direct = data.files[idx];
  if (direct) return direct;

  if (idx !== 0) return null;

  if (section === 'brief_files') {
    const briefText =
      typeof project.brief === 'string' ? (project.brief as string) : '';
    const text = briefText || data.content || data.notes;
    if (!text || !text.trim()) return null;
    return {
      name: 'brief.txt',
      content: text,
      size: text.length,
      type: 'text/plain',
      uploadedAt: '',
    };
  }

  const text = (data.content || data.notes || '').trim();
  if (!text) return null;
  return {
    name: `${section}.txt`,
    content: text,
    size: text.length,
    type: 'text/plain',
    uploadedAt: '',
  };
}
