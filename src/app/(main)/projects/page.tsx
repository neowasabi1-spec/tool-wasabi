'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import { supabase } from '@/lib/supabase';
import {
  Plus, FolderOpen, ChevronRight, ChevronDown, Layers,
  Trash2, Search, Save, X, Upload, Loader2, FileText, Eye,
  ShieldCheck,
} from 'lucide-react';
import {
  parseSectionData, buildSectionBlob, formatFileSize,
  type SectionFile, type SectionData,
} from '@/lib/project-sections';
import {
  paletteFromSection, roleLabel,
  type BrandPalette,
} from '@/lib/brand-colors';
import { classifyFile } from '@/lib/section-routing';
import ImportCheckpointModal from '@/components/projects/ImportCheckpointModal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FunnelRow {
  step: string;
  url: string;
  price: string;
  offerType: string;
}

interface Project {
  id: string;
  name: string;
  status: string;
  description: string;
  domain: string;
  notes: string;
  created_at: string;
  updated_at: string;
  // brief is TEXT; brief_files is JSONB with the file list.
  brief?: string | null;
  brief_files?: any;
  // The other section columns are JSONB.
  market_research?: any;
  front_end?: any;
  back_end?: any;
  compliance_funnel?: any;
  funnel?: any;
}

const TABS = ['Overview', 'Market Research', 'Brief', 'Front End', 'Back End', 'Compliance', 'Funnel'] as const;
type Tab = (typeof TABS)[number];

const STATUS_OPTIONS = ['active', 'in_progress', 'paused', 'completed', 'archived'];

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-green-900 text-green-300',
  in_progress: 'bg-blue-900 text-blue-300',
  paused: 'bg-yellow-900 text-yellow-300',
  completed: 'bg-emerald-900 text-emerald-300',
  archived: 'bg-gray-800 text-gray-500',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractRows(val: any): FunnelRow[] {
  if (!val) return [];
  const rows = typeof val === 'object' ? val.rows : null;
  if (Array.isArray(rows)) return rows as FunnelRow[];
  return [];
}

function emptyRow(): FunnelRow {
  return { step: '', url: '', price: '', offerType: '' };
}

interface DetectedUrl {
  name: string;
  url: string;
  source: 'front_end' | 'back_end' | 'domain';
}

/**
 * Build the URL list shown by the "Import to Checkpoint" modal.
 * Pulls from front_end + back_end rows first (with their step labels)
 * and falls back to project.domain when nothing else is available.
 * Dedupes on URL so the same page isn't imported twice if it appears
 * in both tables.
 */
function detectFunnelUrls(project: Project): DetectedUrl[] {
  const out: DetectedUrl[] = [];
  const seen = new Set<string>();

  const ingest = (
    rows: FunnelRow[],
    source: 'front_end' | 'back_end',
  ) => {
    for (const r of rows) {
      const url = (r.url || '').trim();
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        name:
          (r.step || '').trim() ||
          safeHostname(url) ||
          `Step ${out.length + 1}`,
        url,
        source,
      });
    }
  };

  ingest(extractRows(project.front_end), 'front_end');
  ingest(extractRows(project.back_end), 'back_end');

  // Final fallback: the project's domain field.
  const domain = (project.domain || '').trim();
  if (domain && !seen.has(domain)) {
    seen.add(domain);
    out.push({
      name: project.name || safeHostname(domain) || 'Homepage',
      url: domain,
      source: 'domain',
    });
  }

  return out;
}

function safeHostname(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ─── File parsing helpers ────────────────────────────────────────────────────

const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'rtf', 'html', 'htm', 'xml', 'yaml', 'yml'];

async function parseFileToText(file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
    GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const buffer = await file.arrayBuffer();
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    let allText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map(item => item.str)
        .join(' ');
      allText += pageText + '\n\n';
    }
    return allText.trim();
  }

  if (ext === 'docx') {
    // Best-effort: extract <w:t> text from word/document.xml inside the docx (zip).
    // This avoids a heavy dependency. For richer parsing the user can paste the text.
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      const matches = text.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
      if (matches && matches.length > 0) {
        return matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
      }
    } catch { /* fall through */ }
    throw new Error('Could not parse .docx — please save as .txt or .pdf and try again.');
  }

  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(ws);
  }

  if (TEXT_EXTS.includes(ext) || file.type.startsWith('text/') || !ext) {
    return await file.text();
  }

  throw new Error(`Unsupported file type: .${ext}. Please use .txt, .md, .pdf, .docx, .csv or .xlsx`);
}

async function parseFileToRows(file: File): Promise<FunnelRow[]> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const XLSX = await import('xlsx');
  let raw: Record<string, unknown>[] = [];

  if (['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(ext)) {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    raw = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
  } else if (ext === 'json') {
    const text = await file.text();
    const parsed = JSON.parse(text);
    raw = Array.isArray(parsed) ? parsed : (parsed?.rows || parsed?.steps || []);
  } else {
    throw new Error(`Unsupported file type for table: .${ext}. Please use .csv, .xlsx or .json`);
  }

  return raw.map(r => {
    const lc: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) lc[k.toLowerCase().trim()] = String(v ?? '');
    return {
      step: lc.step || lc.name || lc.page || '',
      url: lc.url || lc.link || lc.href || '',
      price: lc.price || lc.cost || lc.amount || '',
      offerType: lc.offertype || lc['offer type'] || lc.offer || lc.type || '',
    };
  }).filter(r => r.step || r.url || r.price || r.offerType);
}

// ─── Sub-component: Upload Button (single file, used by Front/Back End table) ─

function UploadButton({
  accept,
  onFile,
  label = 'Upload File',
}: {
  accept: string;
  onFile: (file: File) => Promise<void>;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await onFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-[#2A2D3A] hover:bg-[#3A3D4A] text-gray-200 transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
        {busy ? 'Reading...' : label}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

// ─── Sub-component: Brand Palette Preview ────────────────────────────────────

function BrandPalettePreview({ data }: { data: SectionData }) {
  const palette: BrandPalette = paletteFromSection(data.files, data.notes);
  const total = palette.all.length;
  if (total === 0) return null;

  // Build the grid of canonical roles + extras.
  const canonicalEntries: { label: string; hex: string }[] = [];
  const ROLE_ORDER: (keyof BrandPalette)[] = [
    'primary', 'secondary', 'accent', 'ctaBackground', 'ctaText',
    'background', 'text',
  ];
  for (const role of ROLE_ORDER) {
    const hex = palette[role];
    if (typeof hex === 'string') {
      canonicalEntries.push({ label: roleLabel(role as never), hex });
    }
  }
  const extraEntries = Object.entries(palette.extras).map(([label, hex]) => ({
    label, hex,
  }));

  return (
    <div className="mt-3 border border-emerald-900/40 bg-emerald-950/20 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-emerald-300">
          Detected brand colors ({total})
        </div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wide">
          Auto-parsed from uploaded files
        </div>
      </div>
      {canonicalEntries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-2">
          {canonicalEntries.map(({ label, hex }) => (
            <div
              key={label + hex}
              className="flex items-center gap-2 bg-[#0F1117] border border-[#2A2D3A] rounded-md px-2 py-1.5"
            >
              <div
                className="w-6 h-6 rounded border border-black/40 flex-shrink-0"
                style={{ backgroundColor: hex }}
                title={hex}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-white font-medium truncate">{label}</div>
                <div className="text-[10px] text-gray-500 font-mono">{hex}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {extraEntries.length > 0 && (
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer hover:text-gray-200">
            + {extraEntries.length} other color{extraEntries.length !== 1 ? 's' : ''} (unlabelled)
          </summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {extraEntries.map(({ label, hex }) => (
              <div
                key={label + hex}
                className="flex items-center gap-2 bg-[#0F1117] border border-[#2A2D3A] rounded-md px-2 py-1.5"
              >
                <div
                  className="w-5 h-5 rounded border border-black/40 flex-shrink-0"
                  style={{ backgroundColor: hex }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-gray-300 truncate" title={label}>{label}</div>
                  <div className="text-[10px] text-gray-500 font-mono">{hex}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="mt-2 text-[10px] text-gray-500 leading-relaxed">
        These will be used in Step 2 (color detection on the swiped page) and
        Step 3 (CSS replacement). For now they&apos;re just shown so you can verify
        the parser caught the right hex codes from your brand book.
      </div>
    </div>
  );
}

// ─── Sub-component: per-file routing tags ────────────────────────────────────
// Renders the "Always · VSL only · OTO only" badges next to each file so the
// user can see which page-types Claude will actually receive that file for.
// Mirrors the rules in src/lib/section-routing.ts.

function FileRoutingTags({ file }: { file: SectionFile }) {
  const c = classifyFile(file);
  if (c.matched.length === 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 font-medium">
        Always (no rule matched)
      </span>
    );
  }
  // Foundational badges first, then page-type-specific ones.
  return (
    <div className="flex flex-wrap items-center gap-1">
      {c.matched.map((rule, idx) => {
        const isFoundational = rule.pageTypes.length === 0;
        const cls = isFoundational
          ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60'
          : 'bg-blue-900/40 text-blue-300 border-blue-800/60';
        const title = isFoundational
          ? `Always loaded — every page receives this file (matched rule: "${rule.label}")`
          : `Loaded only when pageType ∈ [${rule.pageTypes.join(', ')}]`;
        return (
          <span
            key={idx}
            title={title}
            className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cls}`}
          >
            {isFoundational ? '★ ' : ''}{rule.label}
          </span>
        );
      })}
    </div>
  );
}

// ─── Sub-component: routing preview panel ────────────────────────────────────
// Compact table showing, for each common page type, how many of the user's
// uploaded files would actually reach Claude. Helps the user verify the
// routing rules before kicking off a swipe.

function RoutingPreview({ files }: { files: SectionFile[] }) {
  const PREVIEW_PAGE_TYPES: { key: string; label: string }[] = [
    { key: 'vsl', label: 'VSL' },
    { key: 'landing', label: 'Landing / PDP' },
    { key: 'advertorial', label: 'Advertorial' },
    { key: 'quiz_funnel', label: 'Quiz' },
    { key: 'checkout', label: 'Checkout' },
    { key: 'upsell', label: 'Upsell / OTO' },
  ];
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const classified = files.map((f) => ({ f, c: classifyFile(f) }));

  function isRelevant(c: ReturnType<typeof classifyFile>, pt: string): boolean {
    if (c.matched.length === 0) return true;
    if (c.isFoundational) return true;
    if (c.pageTypes.length === 0) return true;
    return c.pageTypes.includes(pt);
  }

  return (
    <div className="border border-[#2A2D3A] rounded-lg overflow-hidden bg-[#0F1117]/70">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-[#1A1D27]/50 transition-colors"
      >
        <span className="text-xs text-gray-400 font-medium">
          Smart routing preview · how many files reach Claude per page type
        </span>
        <span className="text-[10px] text-gray-500">
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-1">
          <div className="text-[10px] text-gray-500 mb-2 leading-relaxed">
            Foundational files (★) are always sent. Page-type files are sent
            only when their tag matches the page being rewritten. Rename a
            file to change how it&apos;s classified (e.g. add <code>VSL</code>,
            <code>OTO</code>, <code>AVATAR</code>, <code>BRIEF</code>...).
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-[#2A2D3A]">
                <th className="text-left py-1 pr-2 font-medium">Page type</th>
                <th className="text-right py-1 pl-2 font-medium">Files sent</th>
                <th className="text-right py-1 pl-2 font-medium">Chars</th>
              </tr>
            </thead>
            <tbody>
              {PREVIEW_PAGE_TYPES.map((pt) => {
                const sent = classified.filter((x) => isRelevant(x.c, pt.key));
                const chars = sent.reduce((acc, x) => acc + x.f.content.length, 0);
                return (
                  <tr key={pt.key} className="border-b border-[#1A1D27] last:border-b-0">
                    <td className="py-1 pr-2 text-gray-300">{pt.label}</td>
                    <td className="py-1 pl-2 text-right font-mono text-gray-300">
                      {sent.length} / {files.length}
                    </td>
                    <td className="py-1 pl-2 text-right font-mono text-gray-400">
                      {chars.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Section Files Editor (multi-file folder view) ────────────

function SectionFilesEditor({
  data,
  onChange,
  notesPlaceholder,
}: {
  data: SectionData;
  onChange: (next: SectionData) => void;
  notesPlaceholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Notes textarea hidden by default — section is folder-first. The toggle
  // auto-opens when there's already content in notes (legacy migration).
  const [showNotes, setShowNotes] = useState(() => Boolean(data.notes?.trim()));

  const ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.csv,.json,.html,.htm,.rtf,.xml,.yaml,.yml,.log,text/*';

  async function ingestFiles(fileList: FileList | File[]) {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setError(null);
    setBusy(true);
    const next: SectionFile[] = [...data.files];
    const errors: string[] = [];
    for (const file of arr) {
      try {
        const content = await parseFileToText(file);
        if (!content.trim()) {
          errors.push(`${file.name}: empty`);
          continue;
        }
        next.push({
          name: file.name,
          content,
          size: file.size,
          type: file.type || (file.name.split('.').pop() || ''),
          uploadedAt: new Date().toISOString(),
        });
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    onChange({ ...data, files: next });
    setBusy(false);
    if (errors.length) setError(errors.join(' · '));
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(idx: number) {
    const next = data.files.filter((_, i) => i !== idx);
    onChange({ ...data, files: next });
    if (previewIdx === idx) setPreviewIdx(null);
  }

  function setNotes(notes: string) {
    onChange({ ...data, notes });
  }

  // Total chars across all files (raw, before routing). The actual chars
  // sent to Claude depend on the page-type being rewritten — that breakdown
  // lives in the <RoutingPreview> panel above, which is the source of truth.
  // We deliberately do NOT show a global "X truncated" warning here because
  // it would lie: a 290K total can fit comfortably on a VSL page once OTO/
  // Landing-only files are routed away.
  const totalChars = data.files.reduce((acc, f) => acc + f.content.length, 0)
    + (data.notes?.length || 0);

  return (
    <div className="space-y-3">
      {/* Drop zone + upload */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) ingestFiles(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-lg p-4 transition-colors ${
          dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-[#2A2D3A] bg-[#0F1117]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          onChange={(e) => e.target.files && ingestFiles(e.target.files)}
          className="hidden"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Upload className="w-4 h-4" />
            <span>Drop files here or click to upload (PDF, DOCX, TXT, MD, CSV...)</span>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {busy ? 'Reading...' : 'Upload Files'}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
      </div>

      {/* Smart routing preview */}
      <RoutingPreview files={data.files} />

      {/* File list */}
      {data.files.length === 0 ? (
        <div className="text-center text-gray-500 text-xs py-4 border border-[#2A2D3A] rounded-lg bg-[#0F1117]/50">
          No files uploaded yet.
        </div>
      ) : (
        <div className="border border-[#2A2D3A] rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b bg-[#1A1D27] border-[#2A2D3A]">
            <span className="text-xs text-gray-400 font-medium">
              {data.files.length} file{data.files.length !== 1 ? 's' : ''} · {totalChars.toLocaleString()} chars total
              <span className="text-gray-600"> · see &ldquo;Smart routing preview&rdquo; above for what reaches Claude per page type</span>
            </span>
          </div>
          <ul className="divide-y divide-[#2A2D3A]">
            {data.files.map((f, i) => (
              <li key={i} className="px-3 py-2 hover:bg-[#1A1D27]/50 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <FileText className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white truncate">{f.name}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                        <span>{formatFileSize(f.size)}</span>
                        <span>·</span>
                        <span>{f.content.length.toLocaleString()} chars</span>
                        {f.uploadedAt && (
                          <>
                            <span>·</span>
                            <span>{new Date(f.uploadedAt).toLocaleString()}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-1.5">
                        <FileRoutingTags file={f} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setPreviewIdx(previewIdx === i ? null : i)}
                      className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-[#2A2D3A] rounded transition-colors"
                      title="Preview extracted text"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                      title="Remove file"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {previewIdx === i && (
                  <pre className="mt-2 ml-6 p-2 bg-[#0F1117] border border-[#2A2D3A] rounded text-xs text-gray-300 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {f.content.slice(0, 4000)}
                    {f.content.length > 4000 && '\n\n... (truncated, full text is sent to Claude)'}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Free-form notes (collapsed by default — section is folder-first) */}
      <div>
        {!showNotes ? (
          <button
            type="button"
            onClick={() => setShowNotes(true)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Add notes
          </button>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-500">Additional notes (optional)</label>
              {!data.notes?.trim() && (
                <button
                  type="button"
                  onClick={() => setShowNotes(false)}
                  className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                >
                  Hide
                </button>
              )}
            </div>
            <textarea
              value={data.notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={notesPlaceholder || 'Quick notes appended after the uploaded files...'}
              rows={3}
              className="w-full bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-y"
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-component: Table Editor ─────────────────────────────────────────────

function TableEditor({
  rows,
  onChange,
}: {
  rows: FunnelRow[];
  onChange: (rows: FunnelRow[]) => void;
}) {
  function update(i: number, field: keyof FunnelRow, val: string) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r));
    onChange(next);
  }

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 border-b border-[#2A2D3A]">
            <th className="text-left py-2 pr-3 font-medium">Step</th>
            <th className="text-left py-2 pr-3 font-medium">URL</th>
            <th className="text-left py-2 pr-3 font-medium">Price</th>
            <th className="text-left py-2 pr-3 font-medium">Offer Type</th>
            <th className="py-2 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[#1A1D27]">
              {(['step', 'url', 'price', 'offerType'] as (keyof FunnelRow)[]).map(field => (
                <td key={field} className="py-1.5 pr-2">
                  <input
                    value={row[field]}
                    onChange={e => update(i, field, e.target.value)}
                    className="w-full bg-[#0F1117] border border-[#2A2D3A] rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                  />
                </td>
              ))}
              <td className="py-1.5 text-center">
                <button
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="text-gray-600 hover:text-red-400 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() => onChange([...rows, emptyRow()])}
        className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
      >
        <Plus className="w-3 h-3" /> Add row
      </button>
    </div>
  );
}

// ─── Sub-component: Expanded Project Panel ───────────────────────────────────

function ProjectPanel({
  project,
  onUpdate,
  onDelete,
}: {
  project: Project;
  onUpdate: (id: string, fields: Partial<Project>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [saving, setSaving] = useState(false);

  // Overview fields
  const [name, setName] = useState(String(project.name || ''));
  const [status, setStatus] = useState(String(project.status || 'active'));
  const [domain, setDomain] = useState(String(project.domain || ''));
  const [description, setDescription] = useState(String(project.description || ''));
  const [notes, setNotes] = useState(String(project.notes || ''));

  // Multi-file sections (Brief uses TEXT `brief` + JSONB `brief_files`;
  // the others are pure JSONB columns).
  const [marketResearch, setMarketResearch] = useState<SectionData>(
    parseSectionData(project.market_research),
  );
  const [briefData, setBriefData] = useState<SectionData>(() => {
    const fromFiles = parseSectionData(project.brief_files);
    if (fromFiles.files.length > 0 || fromFiles.notes) return fromFiles;
    // Fallback: legacy projects only had the TEXT `brief` column.
    return parseSectionData(project.brief || '');
  });
  const [compliance, setCompliance] = useState<SectionData>(
    parseSectionData(project.compliance_funnel),
  );
  const [funnelData, setFunnelData] = useState<SectionData>(
    parseSectionData(project.funnel),
  );

  // Table fields
  const [frontEndRows, setFrontEndRows] = useState<FunnelRow[]>(extractRows(project.front_end));
  const [backEndRows, setBackEndRows] = useState<FunnelRow[]>(extractRows(project.back_end));

  async function save() {
    setSaving(true);
    const briefBlob = buildSectionBlob(briefData.files, briefData.notes);
    await onUpdate(project.id, {
      name,
      status,
      domain,
      description,
      notes,
      market_research: buildSectionBlob(marketResearch.files, marketResearch.notes),
      // Mirror concatenated text into the legacy TEXT column so every existing
      // reader (rewrite pipeline, MCP, etc.) keeps working unchanged.
      brief: briefBlob.content,
      brief_files: { files: briefBlob.files, notes: briefBlob.notes },
      front_end: { rows: frontEndRows },
      back_end: { rows: backEndRows },
      compliance_funnel: buildSectionBlob(compliance.files, compliance.notes),
      funnel: buildSectionBlob(funnelData.files, funnelData.notes),
    });
    setSaving(false);
  }

  const inputCls =
    'w-full bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
  const textareaCls =
    'w-full bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-y min-h-[160px]';
  const labelCls = 'block text-xs text-gray-400 mb-1 font-medium';

  // Section header (label on the left, optional actions on the right).
  function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
      <div className="flex items-end justify-between mb-1">
        <label className={labelCls + ' mb-0'}>{title}</label>
        {children}
      </div>
    );
  }

  return (
    <div className="border-t border-[#2A2D3A] mt-4 pt-4">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              tab === t
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#2A2D3A]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-4">
        {tab === 'Overview' && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Project Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className={inputCls}
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Domain</label>
              <input value={domain} onChange={e => setDomain(e.target.value)} className={inputCls} placeholder="e.g. https://example.com" />
            </div>
            <div>
              <label className={labelCls}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} className={textareaCls} rows={3} />
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} className={textareaCls} rows={3} />
            </div>
          </>
        )}

        {tab === 'Market Research' && (
          <div>
            <SectionHeader title="Market Research" />
            <SectionFilesEditor
              data={marketResearch}
              onChange={setMarketResearch}
              notesPlaceholder="Extra context, observations, target audience notes..."
            />
            <BrandPalettePreview data={marketResearch} />
          </div>
        )}

        {tab === 'Brief' && (
          <div>
            <SectionHeader title="Brief" />
            <SectionFilesEditor
              data={briefData}
              onChange={setBriefData}
              notesPlaceholder="Goals, requirements, must-haves, tone of voice..."
            />
            <BrandPalettePreview data={briefData} />
          </div>
        )}

        {tab === 'Front End' && (
          <div>
            <SectionHeader title="Front End Funnel Steps">
              <UploadButton
                accept=".csv,.tsv,.xlsx,.xls,.ods,.json"
                label="Upload CSV / Excel"
                onFile={async (file) => {
                  const rows = await parseFileToRows(file);
                  if (rows.length === 0) throw new Error('No rows found in file.');
                  if (frontEndRows.some(r => r.step || r.url || r.price || r.offerType)) {
                    const replace = confirm('Replace existing rows?\n\nOK = Replace · Cancel = Append');
                    setFrontEndRows(replace ? rows : [...frontEndRows, ...rows]);
                  } else {
                    setFrontEndRows(rows);
                  }
                }}
              />
            </SectionHeader>
            <TableEditor rows={frontEndRows} onChange={setFrontEndRows} />
          </div>
        )}

        {tab === 'Back End' && (
          <div>
            <SectionHeader title="Back End Funnel Steps">
              <UploadButton
                accept=".csv,.tsv,.xlsx,.xls,.ods,.json"
                label="Upload CSV / Excel"
                onFile={async (file) => {
                  const rows = await parseFileToRows(file);
                  if (rows.length === 0) throw new Error('No rows found in file.');
                  if (backEndRows.some(r => r.step || r.url || r.price || r.offerType)) {
                    const replace = confirm('Replace existing rows?\n\nOK = Replace · Cancel = Append');
                    setBackEndRows(replace ? rows : [...backEndRows, ...rows]);
                  } else {
                    setBackEndRows(rows);
                  }
                }}
              />
            </SectionHeader>
            <TableEditor rows={backEndRows} onChange={setBackEndRows} />
          </div>
        )}

        {tab === 'Compliance' && (
          <div>
            <SectionHeader title="Compliance" />
            <SectionFilesEditor
              data={compliance}
              onChange={setCompliance}
              notesPlaceholder="Compliance requirements, disclaimers, legal notes..."
            />
          </div>
        )}

        {tab === 'Funnel' && (
          <div>
            <SectionHeader title="Funnel" />
            <SectionFilesEditor
              data={funnelData}
              onChange={setFunnelData}
              notesPlaceholder="Funnel strategy, flow, objectives, narrative..."
            />
          </div>
        )}

        {/* Save / Delete actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[#2A2D3A]">
          <button
            onClick={() => onDelete(project.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 text-xs rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete Project
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [checkpointTarget, setCheckpointTarget] = useState<Project | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    const COLS = 'id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, brief_files, front_end, back_end, compliance_funnel, funnel';
    const { data, error } = await supabase
      .from('projects')
      .select(COLS)
      .order('created_at', { ascending: false });

    // brief_files was added in a later migration; if it's missing fall back
    // to selecting without it so the page still renders.
    const rows = !error
      ? data
      : (await supabase
          .from('projects')
          .select('id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, front_end, back_end, compliance_funnel, funnel')
          .order('created_at', { ascending: false })).data;

    if (rows) {
      setProjects(
        rows.map((p: any) => ({
          id: String(p.id || ''),
          name: typeof p.name === 'string' ? p.name : 'Untitled',
          status: typeof p.status === 'string' ? p.status : 'active',
          description: typeof p.description === 'string' ? p.description : '',
          domain: typeof p.domain === 'string' ? p.domain : '',
          notes: typeof p.notes === 'string' ? p.notes : '',
          created_at: typeof p.created_at === 'string' ? p.created_at : '',
          updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
          brief: typeof p.brief === 'string' ? p.brief : '',
          brief_files: p.brief_files ?? null,
          market_research: p.market_research ?? null,
          front_end: p.front_end ?? null,
          back_end: p.back_end ?? null,
          compliance_funnel: p.compliance_funnel ?? null,
          funnel: p.funnel ?? null,
        })),
      );
    }
    setLoading(false);
  }

  async function addProject() {
    if (!newName.trim()) return;
    setAdding(true);
    const COLS = 'id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, brief_files, front_end, back_end, compliance_funnel, funnel';
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: newName.trim(), status: 'active', description: '' })
      .select(COLS)
      .single();
    if (!error && data) {
      const newProject: Project = {
        id: String(data.id),
        name: String(data.name || ''),
        status: String(data.status || 'active'),
        description: '',
        domain: '',
        notes: '',
        created_at: String(data.created_at || ''),
        updated_at: String(data.updated_at || ''),
        brief: '',
        brief_files: null,
        market_research: null,
        front_end: null,
        back_end: null,
        compliance_funnel: null,
        funnel: null,
      };
      setProjects(prev => [newProject, ...prev]);
      setExpandedId(newProject.id);
      setNewName('');
      setShowAdd(false);
    }
    setAdding(false);
  }

  async function updateProject(id: string, fields: Partial<Project>) {
    let { error } = await supabase.from('projects').update(fields).eq('id', id);
    // Migration `brief_files` may not be applied yet — retry without it.
    if (error && /brief_files/i.test(String(error.message || ''))) {
      const { brief_files: _omit, ...rest } = fields;
      void _omit;
      const retry = await supabase.from('projects').update(rest).eq('id', id);
      error = retry.error;
      if (!error) {
        console.warn('[projects] brief_files column missing — run supabase-migration-projects-section-files.sql');
      }
    }
    if (error) {
      alert(`Save failed: ${error.message}`);
      return;
    }
    setProjects(prev =>
      prev.map(p => (p.id === id ? { ...p, ...fields } : p)),
    );
  }

  async function deleteProject(id: string) {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    await supabase.from('projects').delete().eq('id', id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  // Filter
  const filtered = projects.filter(p => {
    const matchSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.domain.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || p.status === filterStatus;
    return matchSearch && matchStatus;
  });

  return (
    <div className="min-h-screen bg-[#0F1117]">
      <Header title="My Projects" subtitle="Manage your funnel projects" />

      <div className="p-6 max-w-5xl mx-auto">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search projects..."
                className="w-full bg-[#1A1D27] border border-[#2A2D3A] rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Status filter */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="bg-[#1A1D27] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <FolderOpen className="w-4 h-4" />
              <span>{filtered.length} project{filtered.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Project
          </button>
        </div>

        {/* Add form */}
        {showAdd && (
          <div className="bg-[#1A1D27] border border-[#2A2D3A] rounded-xl p-4 mb-4">
            <div className="flex gap-3">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addProject()}
                placeholder="Project name..."
                className="flex-1 bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={addProject}
                disabled={adding || !newName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {adding ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowAdd(false); setNewName(''); }}
                className="px-3 py-2 text-gray-400 hover:text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Project list */}
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading projects...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{projects.length === 0 ? 'No projects yet. Create your first one.' : 'No projects match your search.'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(project => {
              const isOpen = expandedId === project.id;
              return (
                <div
                  key={project.id}
                  className={`bg-[#1A1D27] border rounded-xl transition-colors ${
                    isOpen ? 'border-blue-600/50' : 'border-[#2A2D3A] hover:border-[#3A3D4A]'
                  }`}
                >
                  {/* Row header — click to expand */}
                  <div
                    className="flex items-center justify-between p-5 cursor-pointer"
                    onClick={() => toggleExpand(project.id)}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                        <FolderOpen className="w-5 h-5 text-blue-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-white font-semibold text-base truncate">{project.name}</h3>
                        {project.description ? (
                          <p
                            className="text-gray-400 text-sm mt-0.5 truncate"
                            title={project.description}
                          >
                            {project.description.replace(/\s+/g, ' ').trim()}
                          </p>
                        ) : null}
                        {project.domain ? (
                          <p className="text-blue-400 text-xs mt-0.5 truncate">{project.domain}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                          STATUS_COLOR[project.status] || 'bg-gray-700 text-gray-300'
                        }`}
                      >
                        {project.status}
                      </span>

                      {/* Checkpoint button — imports the project's
                          funnel pages into the audit library. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setCheckpointTarget(project);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-colors"
                        title="Importa le pagine di questo progetto nel Checkpoint"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Checkpoint
                      </button>

                      {/* Flows button */}
                      <Link
                        href={'/projects/' + project.id}
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        Flows
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>

                      {/* Expand chevron */}
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-blue-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </div>
                  </div>

                  {/* Expanded panel */}
                  {isOpen && (
                    <div className="px-5 pb-5">
                      <ProjectPanel
                        project={project}
                        onUpdate={updateProject}
                        onDelete={deleteProject}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Import to Checkpoint modal — opened by the green
          "Checkpoint" button on each project card. */}
      <ImportCheckpointModal
        open={checkpointTarget !== null}
        onClose={() => setCheckpointTarget(null)}
        projectId={checkpointTarget?.id ?? ''}
        projectName={checkpointTarget?.name ?? ''}
        detectedUrls={checkpointTarget ? detectFunnelUrls(checkpointTarget) : []}
      />
    </div>
  );
}
