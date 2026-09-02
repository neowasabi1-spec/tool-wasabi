'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { supabase } from '@/lib/supabase';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm';
import {
  Plus, FolderOpen, ChevronRight, ChevronDown, Layers,
  Trash2, Search, Save, X, Upload, Loader2, FileText, Eye,
  ShieldCheck, LayoutGrid, LayoutList, Share2, Users,
  Rocket, Sparkles,
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
import { ChimeraFunnelPicker, type ChimeraFunnelPick } from '@/components/projecthub/autopilot/ChimeraFunnelPicker';
import { ChimeraImageModeToggle, type ChimeraImageMode } from '@/components/projecthub/autopilot/ChimeraImageModeToggle';

const EMPTY_CHIMERA_FUNNEL: ChimeraFunnelPick = { funnelId: '', steps: [] };

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
  /** UUID of the project owner. Set by the multi-tenancy trigger; used
   *  client-side to tell "owned by me" (no badge) apart from "shared
   *  with me" (SHARED badge, no delete button). */
  owner_user_id?: string | null;
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

interface ProjectShareRow {
  user_id: string;
  email: string | null;
  shared_at: string;
}

interface AdminUserRow {
  user_id: string;
  email: string;
  role: 'master' | 'user';
}

const TABS = ['Overview', 'Market Research', 'Brief', 'Front End', 'Back End', 'Compliance', 'Funnel'] as const;
type Tab = (typeof TABS)[number];

type ViewMode = 'cards' | 'grid';
const VIEW_STORAGE_KEY = 'projects:viewMode';

const STATUS_OPTIONS = ['active', 'in_progress', 'off'] as const;

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  in_progress: 'Progress',
  off: 'Off',
  paused: 'Off',
  completed: 'Completed',
  archived: 'Archived',
};

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  in_progress: 'bg-blue-100 text-blue-700',
  off: 'bg-slate-200 text-slate-600',
  paused: 'bg-slate-200 text-slate-600',
  completed: 'bg-emerald-100 text-emerald-700',
  archived: 'bg-slate-100 text-slate-500',
};

function StatusPicker({
  projectId,
  status,
  onChange,
  className = '',
}: {
  projectId: string;
  status: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = async (next: string) => {
    if (next === status) { setOpen(false); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/projecthub/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || 'Save failed');
      }
      onChange(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update status');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div
      ref={box}
      className={`relative ${className}`}
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(v => !v)}
        title="Change status"
        className={`px-2 py-0.5 rounded-full text-[10px] font-medium capitalize transition-shadow hover:ring-2 hover:ring-offset-1 hover:ring-slate-300 ${
          STATUS_COLOR[status] || 'bg-slate-100 text-slate-600'
        } ${busy ? 'opacity-60' : ''}`}
      >
        {STATUS_LABEL[status] || status}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 min-w-[8rem] bg-white border border-slate-200 rounded-lg shadow-lg py-1">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-slate-50 ${
                s === status ? 'text-slate-900' : 'text-slate-600'
              }`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle ${
                s === 'active' ? 'bg-green-500' : s === 'in_progress' ? 'bg-blue-500' : 'bg-slate-400'
              }`} />
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
        {busy ? 'Reading...' : label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
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
    <div className="mt-3 border border-emerald-200 bg-emerald-50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-emerald-700">
          Detected brand colors ({total})
        </div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wide">
          Auto-parsed from uploaded files
        </div>
      </div>
      {canonicalEntries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-2">
          {canonicalEntries.map(({ label, hex }) => (
            <div
              key={label + hex}
              className="flex items-center gap-2 bg-white border border-slate-200 rounded-md px-2 py-1.5"
            >
              <div
                className="w-6 h-6 rounded border border-slate-300 flex-shrink-0"
                style={{ backgroundColor: hex }}
                title={hex}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-800 font-medium truncate">{label}</div>
                <div className="text-[10px] text-slate-500 font-mono">{hex}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {extraEntries.length > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-800">
            + {extraEntries.length} other color{extraEntries.length !== 1 ? 's' : ''} (unlabelled)
          </summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {extraEntries.map(({ label, hex }) => (
              <div
                key={label + hex}
                className="flex items-center gap-2 bg-white border border-slate-200 rounded-md px-2 py-1.5"
              >
                <div
                  className="w-5 h-5 rounded border border-slate-300 flex-shrink-0"
                  style={{ backgroundColor: hex }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-slate-600 truncate" title={label}>{label}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{hex}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="mt-2 text-[10px] text-slate-500 leading-relaxed">
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
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">
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
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-blue-50 text-blue-700 border-blue-200';
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
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-slate-50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 transition-colors"
      >
        <span className="text-xs text-slate-500 font-medium">
          Smart routing preview · how many files reach Claude per page type
        </span>
        <span className="text-[10px] text-slate-500">
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-1">
          <div className="text-[10px] text-slate-500 mb-2 leading-relaxed">
            Foundational files (★) are always sent. Page-type files are sent
            only when their tag matches the page being rewritten. Rename a
            file to change how it&apos;s classified (e.g. add <code>VSL</code>,
            <code>OTO</code>, <code>AVATAR</code>, <code>BRIEF</code>...).
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-200">
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
                  <tr key={pt.key} className="border-b border-slate-100 last:border-b-0">
                    <td className="py-1 pr-2 text-slate-600">{pt.label}</td>
                    <td className="py-1 pl-2 text-right font-mono text-slate-600">
                      {sent.length} / {files.length}
                    </td>
                    <td className="py-1 pl-2 text-right font-mono text-slate-500">
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
          dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-slate-200 bg-white'
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
          <div className="flex items-center gap-2 text-sm text-slate-500">
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
        {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      </div>

      {/* Smart routing preview */}
      <RoutingPreview files={data.files} />

      {/* File list */}
      {data.files.length === 0 ? (
        <div className="text-center text-slate-500 text-xs py-4 border border-slate-200 rounded-lg bg-slate-50">
          No files uploaded yet.
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b bg-white border-slate-200">
            <span className="text-xs text-slate-500 font-medium">
              {data.files.length} file{data.files.length !== 1 ? 's' : ''} · {totalChars.toLocaleString()} chars total
              <span className="text-slate-500"> · see &ldquo;Smart routing preview&rdquo; above for what reaches Claude per page type</span>
            </span>
          </div>
          <ul className="divide-y divide-slate-200">
            {data.files.map((f, i) => (
              <li key={i} className="px-3 py-2 hover:bg-slate-50 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <FileText className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-800 truncate">{f.name}</div>
                      <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
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
                      className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded transition-colors"
                      title="Preview extracted text"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Remove file"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {previewIdx === i && (
                  <pre className="mt-2 ml-6 p-2 bg-white border border-slate-200 rounded text-xs text-slate-600 max-h-48 overflow-auto whitespace-pre-wrap break-words">
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
            className="text-xs text-slate-500 hover:text-slate-700 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Add notes
          </button>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-slate-500">Additional notes (optional)</label>
              {!data.notes?.trim() && (
                <button
                  type="button"
                  onClick={() => setShowNotes(false)}
                  className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors"
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
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500 resize-y"
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
          <tr className="text-slate-500 border-b border-slate-200">
            <th className="text-left py-2 pr-3 font-medium">Step</th>
            <th className="text-left py-2 pr-3 font-medium">URL</th>
            <th className="text-left py-2 pr-3 font-medium">Price</th>
            <th className="text-left py-2 pr-3 font-medium">Offer Type</th>
            <th className="py-2 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100">
              {(['step', 'url', 'price', 'offerType'] as (keyof FunnelRow)[]).map(field => (
                <td key={field} className="py-1.5 pr-2">
                  <input
                    value={row[field]}
                    onChange={e => update(i, field, e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-slate-900 text-xs focus:outline-none focus:border-blue-500"
                  />
                </td>
              ))}
              <td className="py-1.5 text-center">
                <button
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-red-600 transition-colors"
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
        className="mt-2 text-xs text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1"
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
    'w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500';
  const textareaCls =
    'w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500 resize-y min-h-[160px]';
  const labelCls = 'block text-xs text-slate-500 mb-1 font-medium';

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
    <div className="border-t border-slate-200 mt-4 pt-4">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              tab === t
                ? 'bg-blue-600 text-white'
                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
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
                      {STATUS_LABEL[s]}
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
                    const replace = await confirmDialog({ title: 'Righe esistenti', message: 'Vuoi sostituire le righe esistenti o aggiungerle in coda?', confirmText: 'Sostituisci', cancelText: 'Aggiungi' });
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
                    const replace = await confirmDialog({ title: 'Righe esistenti', message: 'Vuoi sostituire le righe esistenti o aggiungerle in coda?', confirmText: 'Sostituisci', cancelText: 'Aggiungi' });
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
        <div className="flex items-center justify-between pt-2 border-t border-slate-200">
          <button
            onClick={() => onDelete(project.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 text-xs rounded-lg transition-colors"
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
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  // ── Autopilot launcher (create-or-update a project and run the full pipeline) ──
  const [showAutopilot, setShowAutopilot] = useState(false);
  const [apProduct, setApProduct] = useState('');
  const [apCompetitor, setApCompetitor] = useState('');
  const [apMarket, setApMarket] = useState('');
  const [apDesc, setApDesc] = useState('');
  const [apFunnelPick, setApFunnelPick] = useState<ChimeraFunnelPick>(EMPTY_CHIMERA_FUNNEL);
  const [apImageMode, setApImageMode] = useState<ChimeraImageMode>('internal');
  const [apLaunching, setApLaunching] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [checkpointTarget, setCheckpointTarget] = useState<Project | null>(null);
  // View toggle: 'cards' = current expandable list (default), 'grid' = compact tiles.
  // The choice is persisted in localStorage so it sticks across sessions.
  const [view, setView] = useState<ViewMode>('cards');

  // ── Sharing ────────────────────────────────────────────────────────
  // Master only: assign per-user collaborative access on a project.
  // Regular users see a "SHARED" badge on cards they don't own but
  // don't get the Share button itself.
  const { user: currentUser, permissions } = useCurrentUser();
  const isMaster = permissions?.role === 'master';
  const currentUserId = currentUser?.id || null;
  const [shareTarget, setShareTarget] = useState<Project | null>(null);
  const [shareUsers, setShareUsers] = useState<AdminUserRow[]>([]);
  const [shareSelected, setShareSelected] = useState<Set<string>>(new Set());
  const [shareLoading, setShareLoading] = useState(false);
  const [shareSaving, setShareSaving] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  async function openShareModal(project: Project) {
    setShareTarget(project);
    setShareError(null);
    setShareLoading(true);
    setShareSelected(new Set());
    try {
      // Pull users + current shares in parallel. Master is filtered out
      // (sharing a project with the master is meaningless — they see
      // everything via the role check).
      const [usersRes, sharesRes] = await Promise.all([
        fetch('/api/admin/users', { cache: 'no-store' }),
        fetch(`/api/projecthub/projects/${project.id}/shares`, { cache: 'no-store' }),
      ]);
      if (!usersRes.ok) throw new Error(`users HTTP ${usersRes.status}`);
      if (!sharesRes.ok) throw new Error(`shares HTTP ${sharesRes.status}`);
      const usersBody = (await usersRes.json()) as { users: AdminUserRow[] };
      const sharesBody = (await sharesRes.json()) as { shares: ProjectShareRow[] };
      const ownerId = project.owner_user_id || null;
      const eligible = (usersBody.users || []).filter(
        (u) => u.role !== 'master' && u.user_id !== ownerId,
      );
      setShareUsers(eligible);
      setShareSelected(new Set((sharesBody.shares || []).map((s) => s.user_id)));
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    } finally {
      setShareLoading(false);
    }
  }

  function toggleShareUser(userId: string) {
    setShareSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function saveShares() {
    if (!shareTarget) return;
    setShareSaving(true);
    setShareError(null);
    try {
      const res = await fetch(`/api/projecthub/projects/${shareTarget.id}/shares`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: Array.from(shareSelected) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setShareTarget(null);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    } finally {
      setShareSaving(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'cards' || stored === 'grid') setView(stored);
  }, []);

  function setViewMode(next: ViewMode) {
    setView(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    }
    // Collapse any open project when switching to grid — the grid layout
    // does not have an inline expand panel.
    if (next === 'grid') setExpandedId(null);
  }

  async function loadProjects() {
    setLoading(true);
    // owner_user_id is included so the UI can tell apart "owned by me"
    // (no badge, can delete) from "shared with me" (SHARED badge, no
    // delete button). On older installs without the multi-tenancy
    // column this just comes back as undefined and the UI degrades to
    // the legacy "everything looks owned by me" behavior.
    const COLS = 'id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, brief_files, front_end, back_end, compliance_funnel, funnel, owner_user_id';
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
          .select('id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, front_end, back_end, compliance_funnel, funnel, owner_user_id')
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
          owner_user_id: typeof p.owner_user_id === 'string' ? p.owner_user_id : null,
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

    // IMPORTANT: do NOT call supabase.from('projects').insert() directly
    // from the browser. With phase-2 multi-tenancy RLS the INSERT policy
    // is `owner_user_id = auth.uid() OR is_master(auth.uid())`. The
    // browser client splices the JWT into requests, so in theory
    // auth.uid() = the logged-in user — but in practice users were
    // hitting "row-level security for table projects" because the JWT
    // was either not attached (stale wasabi_session), or expired, or
    // the auto_owner_user_id trigger isn't installed on this DB,
    // leaving owner_user_id NULL and the WITH CHECK clause failing.
    //
    // Going through the API route is the canonical, defensively-safe
    // path: it verifies the user JWT server-side (getCurrentUserId),
    // uses supabaseAdmin (service-role → bypasses RLS), and sets
    // owner_user_id explicitly. Works regardless of trigger state.
    const res = await fetch('/api/projecthub/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setAdding(false);
      toast.error(`Create failed: ${body?.error || `HTTP ${res.status}`}`);
      return;
    }

    const data = (await res.json()) as {
      id: string;
      name?: string;
      status?: string;
      created_at?: string;
      updated_at?: string;
    };

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
    setAdding(false);
  }

  async function launchAutopilot() {
    if (!apProduct.trim()) {
      toast.error('Enter at least the product name.');
      return;
    }
    setApLaunching(true);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: apProduct.trim(),
          competitorLink: apCompetitor.trim() || undefined,
          market: apMarket.trim() || undefined,
          description: apDesc.trim() || undefined,
          funnelId: apFunnelPick.steps.length ? apFunnelPick.funnelId || undefined : undefined,
          funnelSteps: apFunnelPick.steps.length ? apFunnelPick.steps : undefined,
          funnelStepIndexes: apFunnelPick.steps.length ? apFunnelPick.steps.map((s) => s.index) : undefined,
          imageMode: apImageMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Launch failed');
      toast.success(data.created ? 'Project created — Chimera Protocol started.' : 'Chimera Protocol started on the existing project.');
      // Jump straight to the project's Autopilot tab to watch progress.
      router.push(`/projects/${data.projectId}?section=autopilot`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApLaunching(false);
    }
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
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    setProjects(prev =>
      prev.map(p => (p.id === id ? { ...p, ...fields } : p)),
    );
  }

  async function deleteProject(id: string) {
    if (!(await confirmDialog({ title: 'Elimina progetto', message: 'Eliminare questo progetto? L\'operazione non è reversibile.', confirmText: 'Elimina', danger: true }))) return;
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
    const matchStatus = filterStatus === 'all'
      || p.status === filterStatus
      || (filterStatus === 'off' && p.status === 'paused');
    return matchSearch && matchStatus;
  });

  return (
    <div className="min-h-screen bg-white">
      <Header title="My Projects" subtitle="Manage your funnel projects" />

      <div className="p-6 max-w-5xl mx-auto">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search projects..."
                className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Status filter */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <FolderOpen className="w-4 h-4" />
              <span>{filtered.length} project{filtered.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* View toggle: grid (compact tiles) vs cards (expandable list) */}
            <div
              role="tablist"
              aria-label="View mode"
              className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={view === 'cards'}
                onClick={() => setViewMode('cards')}
                title="Cards"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  view === 'cards'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <LayoutList className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Cards</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'grid'}
                onClick={() => setViewMode('grid')}
                title="Grid"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  view === 'grid'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Grid</span>
              </button>
            </div>

            <button
              onClick={() => { setShowAutopilot(v => !v); setShowAdd(false); }}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Rocket className="w-4 h-4" />
              New with Chimera Protocol
            </button>

            <button
              onClick={() => { setShowAdd(!showAdd); setShowAutopilot(false); }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          </div>
        </div>

        {/* Autopilot launcher */}
        {showAutopilot && (
          <div className="bg-white border border-violet-200 rounded-xl p-5 mb-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Rocket className="w-4 h-4 text-violet-600" />
              <h3 className="text-sm font-semibold text-slate-900">New project with Chimera Protocol</h3>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Same form as Chimera inside a project: product, competitor, market, funnel from Templates, then it
              creates/updates the project and runs market research → brief → competitor → ads → landing.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                type="text"
                value={apProduct}
                onChange={e => setApProduct(e.target.value)}
                placeholder="Product name (e.g. Rivela anti-age cream)"
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-violet-500"
                autoFocus
                disabled={apLaunching}
              />
              <input
                type="text"
                value={apCompetitor}
                onChange={e => setApCompetitor(e.target.value)}
                placeholder="Competitor link (optional)"
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-violet-500"
                disabled={apLaunching}
              />
            </div>
            <input
              type="text"
              value={apMarket}
              onChange={e => setApMarket(e.target.value)}
              placeholder="Target market / language (e.g. Germany · German). Optional: otherwise inferred from the description"
              className="mt-3 w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-violet-500"
              disabled={apLaunching}
            />
            <div className="mt-3">
              <ChimeraFunnelPicker
                id="new-ap-funnel"
                value={apFunnelPick}
                onChange={setApFunnelPick}
                disabled={apLaunching}
                selectClassName="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-violet-500 disabled:opacity-50"
              />
            </div>
            <div className="mt-3">
              <ChimeraImageModeToggle
                value={apImageMode}
                onChange={setApImageMode}
                disabled={apLaunching}
              />
            </div>
            <textarea
              value={apDesc}
              onChange={e => setApDesc(e.target.value)}
              placeholder="Description / notes (optional): ingredients, benefits, price, target, tone..."
              rows={3}
              className="mt-3 w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-violet-500 resize-y"
              disabled={apLaunching}
            />
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={launchAutopilot}
                disabled={apLaunching || !apProduct.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {apLaunching
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Launching…</>
                  : <><Sparkles className="w-4 h-4" /> Start Chimera Protocol</>}
              </button>
              <button
                onClick={() => {
                  setShowAutopilot(false);
                  setApProduct('');
                  setApCompetitor('');
                  setApMarket('');
                  setApDesc('');
                  setApFunnelPick(EMPTY_CHIMERA_FUNNEL);
                  setApImageMode('internal');
                }}
                disabled={apLaunching}
                className="px-3 py-2 text-slate-500 hover:text-slate-900 text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Add form */}
        {showAdd && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
            <div className="flex gap-3">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addProject()}
                placeholder="Project name..."
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm focus:outline-none focus:border-blue-500"
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
                className="px-3 py-2 text-slate-500 hover:text-slate-900 text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Project list */}
        {loading ? (
          <div className="text-center text-slate-500 py-20 animate-pulse">Loading projects...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-500 py-20">
            <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{projects.length === 0 ? 'No projects yet. Create your first one.' : 'No projects match your search.'}</p>
          </div>
        ) : view === 'grid' ? (
          /* Grid view — compact tiles, click to navigate to /projects/[id]/flow */
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {filtered.map(project => {
              // "Shared with me": regular user seeing a project they
              // don't own (only possible because the master gave them
              // a project_shares row). Master view never shows the
              // badge — they own/see everything by definition.
              const isOwned = !project.owner_user_id || project.owner_user_id === currentUserId;
              const showSharedBadge = !isMaster && currentUserId !== null && !isOwned;
              return (
              <Link
                key={project.id}
                href={'/projects/' + project.id}
                className="group bg-white border border-slate-200 shadow-sm hover:border-blue-400 hover:shadow-md rounded-xl p-4 transition-all flex flex-col relative"
              >
                {/* Top-right actions: Delete (owner/master only) +
                    Share (master only). Collaborators must NOT see the
                    delete button — backend will 403 anyway, but
                    hiding it avoids confusion. */}
                <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
                  {isMaster && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openShareModal(project);
                      }}
                      title="Share with users"
                      aria-label={`Share project ${project.name}`}
                      className="p-1.5 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {(isMaster || isOwned) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deleteProject(project.id);
                      }}
                      title="Delete project"
                      aria-label={`Delete project ${project.name}`}
                      className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <FolderOpen className="w-5 h-5 text-blue-600" />
                  </div>
                  <StatusPicker
                    projectId={project.id}
                    status={project.status}
                    className="mr-14"
                    onChange={next => setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: next } : p))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <h3 className="text-slate-900 font-semibold text-sm truncate">
                    {project.name}
                  </h3>
                  {showSharedBadge && (
                    <span
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 flex-shrink-0"
                      title="This project was shared with you"
                    >
                      <Share2 className="w-2.5 h-2.5" />
                      SHARED
                    </span>
                  )}
                </div>
                {project.domain ? (
                  <p className="text-blue-600 text-xs mt-0.5 truncate">{project.domain}</p>
                ) : (
                  <p className="text-slate-500 text-xs mt-0.5 italic">no domain</p>
                )}
                {project.description ? (
                  <p
                    className="text-slate-500 text-xs mt-1.5 line-clamp-2"
                    title={project.description}
                  >
                    {project.description.replace(/\s+/g, ' ').trim()}
                  </p>
                ) : null}
                <div className="mt-auto pt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCheckpointTarget(project);
                    }}
                    className="flex items-center gap-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-medium rounded transition-colors"
                    title="Import to Checkpoint"
                  >
                    <ShieldCheck className="w-3 h-3" />
                    Checkpoint
                  </button>
                  <span className="flex items-center gap-1 text-indigo-600 text-[10px] font-medium group-hover:text-indigo-700">
                    Flows
                    <ChevronRight className="w-3 h-3" />
                  </span>
                </div>
              </Link>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(project => {
              const isOpen = expandedId === project.id;
              const isOwned = !project.owner_user_id || project.owner_user_id === currentUserId;
              const showSharedBadge = !isMaster && currentUserId !== null && !isOwned;
              return (
                <div
                  key={project.id}
                  className={`bg-white border rounded-xl shadow-sm transition-colors ${
                    isOpen ? 'border-blue-400' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {/* Row header — click to expand */}
                  <div
                    className="flex items-center justify-between p-5 cursor-pointer"
                    onClick={() => toggleExpand(project.id)}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                        <FolderOpen className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-slate-900 font-semibold text-base truncate">{project.name}</h3>
                          {showSharedBadge && (
                            <span
                              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 flex-shrink-0"
                              title="This project was shared with you"
                            >
                              <Share2 className="w-3 h-3" />
                              SHARED
                            </span>
                          )}
                        </div>
                        {project.description ? (
                          <p
                            className="text-slate-500 text-sm mt-0.5 truncate"
                            title={project.description}
                          >
                            {project.description.replace(/\s+/g, ' ').trim()}
                          </p>
                        ) : null}
                        {project.domain ? (
                          <p className="text-blue-600 text-xs mt-0.5 truncate">{project.domain}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <StatusPicker
                        projectId={project.id}
                        status={project.status}
                        onChange={next => setProjects(prev => prev.map(p => p.id === project.id ? { ...p, status: next } : p))}
                      />

                      {/* Checkpoint button — imports the project's
                          funnel pages into the audit library. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setCheckpointTarget(project);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-colors"
                        title="Import this project's pages into Checkpoint"
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

                      {/* Share — master only. Opens the modal that
                          assigns per-user collaborative access. */}
                      {isMaster && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openShareModal(project);
                          }}
                          title="Share with users"
                          aria-label={`Share project ${project.name}`}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 text-xs font-medium rounded-lg transition-colors"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                          Share
                        </button>
                      )}

                      {/* Delete project — owner/master only.
                          Collaborators must not delete the master's
                          project (backend also returns 403). */}
                      {(isMaster || isOwned) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteProject(project.id);
                          }}
                          title="Delete project"
                          aria-label={`Delete project ${project.name}`}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 text-xs font-medium rounded-lg transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete
                        </button>
                      )}

                      {/* Expand chevron */}
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-blue-600" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500" />
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

      {/* Share modal — master only. Master picks which regular users
          get collaborative access (read + edit, no delete) on the
          selected project. Backed by PUT /api/projecthub/projects/:id/shares
          which does a full-replace diff. */}
      {shareTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => !shareSaving && setShareTarget(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
              <div className="min-w-0">
                <h2 className="text-slate-900 font-semibold text-base flex items-center gap-2">
                  <Share2 className="w-4 h-4 text-indigo-600" />
                  Share project
                </h2>
                <p className="text-slate-500 text-xs mt-1 truncate" title={shareTarget.name}>
                  {shareTarget.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => !shareSaving && setShareTarget(null)}
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {shareLoading ? (
                <div className="flex items-center justify-center text-slate-500 py-10 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading users…
                </div>
              ) : shareError ? (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  {shareError}
                </div>
              ) : shareUsers.length === 0 ? (
                <div className="text-center text-slate-500 text-sm py-10">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No other users to share with yet.
                  <br />
                  Create users from the <span className="text-indigo-300">Users</span> section.
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-500 mb-3">
                    Selected users will see this project in their <em>My Projects</em>
                    {' '}and will be able to edit brief, files and funnel steps. They
                    won&apos;t be able to delete the project.
                  </p>
                  <ul className="space-y-1.5">
                    {shareUsers.map((u) => {
                      const checked = shareSelected.has(u.user_id);
                      return (
                        <li key={u.user_id}>
                          <label
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                              checked
                                ? 'bg-indigo-50 border border-indigo-300'
                                : 'bg-white border border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleShareUser(u.user_id)}
                              className="accent-indigo-500 w-4 h-4"
                            />
                            <span className="text-sm text-slate-800 truncate">{u.email}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShareTarget(null)}
                disabled={shareSaving}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveShares}
                disabled={shareSaving || shareLoading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg transition-colors"
              >
                {shareSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
