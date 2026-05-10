// Shared helpers for the multi-file project sections (Brief, Market Research,
// Compliance, Funnel). Each section column in the `projects` table is a JSONB
// blob with the unified shape:
//
//   {
//     "files":   [{ "name": "...", "content": "...", "size": 123, "type": "...", "uploadedAt": "..." }],
//     "notes":   "free-form text",
//     "content": "concatenated text of all files + notes — kept for back-compat
//                 with the rewrite pipeline which already reads `.content`"
//   }
//
// The `brief` column is special: it is a TEXT column, so we mirror the
// concatenated text into it directly and store the file list in the new
// `brief_files` JSONB column.

export interface SectionFile {
  name: string;
  content: string;
  size: number;
  type: string;
  uploadedAt: string;
}

export interface SectionData {
  files: SectionFile[];
  notes: string;
  content: string;
}

/** Header used between concatenated file contents so Claude can see file
 *  boundaries and filenames inside one big context block. */
const FILE_DIVIDER = (name: string) => `\n\n=== FILE: ${name} ===\n\n`;

/** Build the canonical concatenated text from a list of files + free notes. */
export function buildSectionContent(files: SectionFile[], notes: string): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f?.content?.trim()) continue;
    parts.push(`${FILE_DIVIDER(f.name).trim()}\n${f.content.trim()}`);
  }
  if (notes?.trim()) {
    parts.push(`\n\n=== NOTES ===\n\n${notes.trim()}`);
  }
  return parts.join('\n').trim();
}

/** If the given string looks like a JSON-serialized SectionData, parse it
 *  and return the parsed SectionData. Otherwise return null. We detect it
 *  by requiring `files` to be present as an array — a much stricter check
 *  than "starts with {" so we don't accidentally swallow user JSON notes. */
function tryParseAsSectionShape(s: unknown): SectionData | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>).files)
    ) {
      return parseSectionData(parsed);
    }
  } catch { /* not JSON */ }
  return null;
}

/** Normalize whatever shape we read back from the DB into the canonical
 *  SectionData. Supports:
 *    - null/undefined         → empty
 *    - plain string           → treated as notes (legacy textarea)
 *    - { content: string }    → legacy single-textarea shape
 *    - { files, notes, ... }  → new shape, used as-is
 *
 *  Bonus: any string field that is itself a JSON-serialized SectionData
 *  (shape with `files` array) is detected and recursively parsed. This
 *  rescues legacy rows where the multi-file blob ended up stringified
 *  into `.notes` or `.content` by mistake — without this the UI would
 *  show raw JSON inside the notes textarea and the file list would be
 *  empty.
 */
export function parseSectionData(val: unknown): SectionData {
  if (val == null || val === '') {
    return { files: [], notes: '', content: '' };
  }

  // String path: maybe it's our own shape stringified, otherwise legacy
  // free-form notes.
  if (typeof val === 'string') {
    const reparsed = tryParseAsSectionShape(val);
    if (reparsed) return reparsed;
    return { files: [], notes: val, content: val };
  }

  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;

    // Object path: notes or content might still hold a stringified shape.
    const reparsedNotes = tryParseAsSectionShape(obj.notes);
    if (reparsedNotes) return reparsedNotes;
    const reparsedContent = tryParseAsSectionShape(obj.content);
    if (reparsedContent) return reparsedContent;

    const filesRaw = Array.isArray(obj.files) ? (obj.files as unknown[]) : [];
    const files: SectionFile[] = filesRaw
      .map((f) => {
        if (!f || typeof f !== 'object') return null;
        const r = f as Record<string, unknown>;
        return {
          name: typeof r.name === 'string' ? r.name : 'untitled',
          content: typeof r.content === 'string' ? r.content : '',
          size: typeof r.size === 'number' ? r.size : 0,
          type: typeof r.type === 'string' ? r.type : '',
          uploadedAt: typeof r.uploadedAt === 'string' ? r.uploadedAt : '',
        } as SectionFile;
      })
      .filter((f): f is SectionFile => f !== null);
    const notes = typeof obj.notes === 'string' ? obj.notes : '';
    let content = typeof obj.content === 'string' ? obj.content : '';
    if (!content) content = buildSectionContent(files, notes);
    return { files, notes, content };
  }

  return { files: [], notes: '', content: '' };
}

/** One-shot: pull just the text content out of any supported section shape.
 *  Used by the Claude rewrite pipeline which only cares about the text. */
export function extractSectionContent(val: unknown): string {
  return parseSectionData(val).content;
}

/** Build the JSONB blob to write back to a JSONB section column. */
export function buildSectionBlob(files: SectionFile[], notes: string): SectionData {
  return {
    files,
    notes,
    content: buildSectionContent(files, notes),
  };
}

/** Pretty-print a byte size for the file list UI. */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Per-section character cap enforced by the rewrite Edge Function before
 *  forwarding to Claude. KEEP IN SYNC with `SECTION_CHAR_LIMIT` in
 *  supabase/functions/funnel-swap-v1-functions/index.ts. */
export const CLAUDE_SECTION_CHAR_LIMIT = 200_000;
