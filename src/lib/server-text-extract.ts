/**
 * Server-side text extraction helper used by `/api/projecthub/projects/[id]/files`
 * to mirror uploaded documents into the legacy `brief_files` / `market_research`
 * JSONB columns on the `projects` table.
 *
 * Why mirror at all?  The Frontend rewrite pipeline (see `getProjectBriefText`
 * in `/front-end-funnel/page.tsx`) only reads the legacy columns. Files uploaded
 * through the new `GeneralBriefSection.tsx` UI live in `project_files` + Supabase
 * Storage, so without this mirror the rewrite reports "Brief mancante" even
 * when the user has clearly uploaded the document.
 *
 * Supported formats (best-effort, never throws — returns "" on failure so the
 * upload itself still succeeds):
 *   - PDF              → pdfjs-dist (legacy Node build)
 *   - DOCX             → unzip + parse <w:t> from word/document.xml
 *   - XLSX / XLS / ODS → xlsx → CSV
 *   - TXT / MD / CSV / TSV / JSON / HTML / RTF / XML / YAML / LOG / plain → UTF-8 decode
 *   - anything else    → ""
 */

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log',
  'rtf', 'html', 'htm', 'xml', 'yaml', 'yml',
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

async function extractPdf(buf: Buffer): Promise<string> {
  // pdfjs-dist v5 ships a Node-friendly build under legacy/. We import it
  // dynamically so the rest of the route doesn't pay the cost when the
  // upload is e.g. a .txt file.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Disable worker in Node — pdfjs falls back to running everything on the
  // main thread which is exactly what we want for a one-shot extraction.
  (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = '';
  const loadingTask = (pdfjs as unknown as {
    getDocument: (opts: unknown) => { promise: Promise<unknown> };
  }).getDocument({
    data: new Uint8Array(buf),
    useWorker: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const pdf = (await loadingTask.promise) as {
    numPages: number;
    getPage: (n: number) => Promise<{
      getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
    }>;
  };
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join(' ');
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

async function extractDocx(buf: Buffer): Promise<string> {
  // DOCX is a ZIP archive. word/document.xml holds the prose inside <w:t>
  // tags. Use jszip (already in deps) to unzip, then a regex to pull text.
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const docXml = zip.file('word/document.xml');
  if (!docXml) return '';
  const xml = await docXml.async('string');
  const matches = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
  if (!matches) return '';
  // Insert paragraph breaks on </w:p> so headings/paragraphs stay separated.
  const withBreaks = xml.replace(/<\/w:p>/g, '\n');
  const m2 = withBreaks.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
  const useMatches = m2 || matches;
  return useMatches
    .map((tag) => tag.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ ]+/g, '\n')
    .trim();
}

async function extractSpreadsheet(buf: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(ws);
    if (csv.trim()) {
      parts.push(`=== Sheet: ${sheetName} ===\n${csv.trim()}`);
    }
  }
  return parts.join('\n\n').trim();
}

/** Returns the extracted text or `""` if the format isn't supported / extraction
 *  failed. Never throws — uploads should keep working even when we can't read
 *  the file content (e.g. a .png that the user dropped into the Brief tab). */
export async function extractTextFromUpload(
  filename: string,
  contentType: string,
  buf: Buffer,
): Promise<string> {
  const ext = extOf(filename);
  try {
    if (ext === 'pdf' || contentType === 'application/pdf') {
      return await extractPdf(buf);
    }
    if (
      ext === 'docx' ||
      contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return await extractDocx(buf);
    }
    if (['xlsx', 'xls', 'ods'].includes(ext)) {
      return await extractSpreadsheet(buf);
    }
    if (TEXT_EXTS.has(ext) || contentType.startsWith('text/')) {
      return new TextDecoder('utf-8', { fatal: false }).decode(buf).trim();
    }
  } catch (err) {
    console.warn(
      `[server-text-extract] failed on ${filename} (${ext}):`,
      err instanceof Error ? err.message : err,
    );
  }
  return '';
}
