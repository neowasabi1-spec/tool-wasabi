'use client';

import { useState, useEffect, use, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import {
  ChevronLeft, ChevronRight, FileText, Layers, Library, Palette,
  ShieldCheck, BarChart3, Plus, X, Pencil, Image as ImageIcon,
  Upload, Trash2, type LucideIcon,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  status: string;
  description: string;
  domain: string;
}

interface Flow {
  id: string;
  name: string;
  status: string;
  is_active: boolean;
  created_at: string;
}

type SectionKey =
  | 'general_brief'
  | 'funnel'
  | 'competitor_library'
  | 'creative'
  | 'chief'
  | 'analytics';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: SectionDef[] = [
  { key: 'general_brief', label: 'General Brief', icon: FileText },
  { key: 'funnel', label: 'Funnel', icon: Layers },
  { key: 'competitor_library', label: 'Competitor Library', icon: Library },
  { key: 'creative', label: 'Creative', icon: Palette },
  { key: 'chief', label: 'Chief', icon: ShieldCheck },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
];

interface Tab {
  id: string;
  name: string;
  /** Color theme for the badge / pill. */
  color: 'green' | 'blue' | 'purple' | 'pink' | 'orange' | 'slate';
}

interface DocumentFile {
  name: string;
  size: number;
  type: string;
  dataUrl: string;
  uploadedAt: string;
}

interface ImageFile {
  name: string;
  size: number;
  dataUrl: string;
  uploadedAt: string;
}

interface TabContent {
  document?: DocumentFile;
  images?: ImageFile[];
}

// ─── Tab color presets (dark-mode friendly) ──────────────────────────────────
// Map a tab "color" key to Tailwind classes for the badge (small numbered
// circle to the left of the tab name) and for the big pill that appears
// above the cards in the active tab.

const TAB_COLOR: Record<Tab['color'], { badge: string; pill: string; underline: string }> = {
  green:  { badge: 'bg-emerald-900/50 text-emerald-300', pill: 'bg-emerald-600',  underline: 'border-emerald-500' },
  blue:   { badge: 'bg-blue-900/50 text-blue-300',       pill: 'bg-blue-600',     underline: 'border-blue-500' },
  purple: { badge: 'bg-purple-900/50 text-purple-300',   pill: 'bg-purple-600',   underline: 'border-purple-500' },
  pink:   { badge: 'bg-pink-900/50 text-pink-300',       pill: 'bg-pink-600',     underline: 'border-pink-500' },
  orange: { badge: 'bg-orange-900/50 text-orange-300',   pill: 'bg-orange-600',   underline: 'border-orange-500' },
  slate:  { badge: 'bg-slate-700/60 text-slate-200',     pill: 'bg-slate-600',    underline: 'border-slate-400' },
};

// Heuristic: pick a sensible default color based on tab name.
function suggestColor(name: string): Tab['color'] {
  const n = name.toLowerCase();
  if (/oto\s*1|otto?1/.test(n)) return 'orange';
  if (/oto\s*2|otto?2/.test(n)) return 'pink';
  if (/oto\s*3|otto?3/.test(n)) return 'purple';
  if (/front|fe\b|landing/.test(n)) return 'blue';
  if (/back|be\b|upsell/.test(n)) return 'purple';
  if (/checkout|order/.test(n)) return 'green';
  return 'slate';
}

// ─── localStorage helpers (per project) ──────────────────────────────────────

function tabsKey(projectId: string): string {
  return `project:${projectId}:tabs`;
}
function tabContentKey(projectId: string, tabId: string): string {
  return `project:${projectId}:tab:${tabId}:content`;
}
function sectionKey(projectId: string): string {
  return `project:${projectId}:section`;
}

function loadTabs(projectId: string): Tab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(tabsKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is Tab =>
      typeof t === 'object' && t && typeof t.id === 'string' && typeof t.name === 'string',
    );
  } catch {
    return [];
  }
}

function saveTabs(projectId: string, tabs: Tab[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(tabsKey(projectId), JSON.stringify(tabs)); } catch {}
}

function loadTabContent(projectId: string, tabId: string): TabContent {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(tabContentKey(projectId, tabId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as TabContent : {};
  } catch {
    return {};
  }
}

function saveTabContent(projectId: string, tabId: string, content: TabContent): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(tabContentKey(projectId, tabId), JSON.stringify(content));
  } catch (err) {
    // Most likely QuotaExceededError — files too big for localStorage.
    alert(
      'Spazio locale esaurito (limite ~5 MB del browser).\n\n' +
      'Per ora togli qualche file: il salvataggio su Supabase Storage arriva nel prossimo step.',
    );
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ProjectDetailPage({
  params,
}: {
  params: { id: string } | Promise<{ id: string }>;
}) {
  const resolvedParams = params instanceof Promise ? use(params) : params;
  const id = resolvedParams.id;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<SectionKey>('general_brief');

  useEffect(() => { loadProject(); }, [id]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(sectionKey(id));
    if (stored && SECTIONS.some((s) => s.key === stored)) {
      setSection(stored as SectionKey);
    }
  }, [id]);

  async function loadProject() {
    setLoading(true);
    const { data } = await supabase
      .from('projects')
      .select('id, name, status, description, domain')
      .eq('id', id)
      .single();
    if (data) {
      setProject({
        id: String(data.id || ''),
        name: typeof data.name === 'string' ? data.name : 'Untitled',
        status: typeof data.status === 'string' ? data.status : 'active',
        description: typeof data.description === 'string' ? data.description : '',
        domain: typeof data.domain === 'string' ? data.domain : '',
      });
    }
    setLoading(false);
  }

  function pickSection(next: SectionKey) {
    setSection(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(sectionKey(id), next);
    }
  }

  const sectionLabel = SECTIONS.find((s) => s.key === section)?.label || 'General Brief';

  return (
    <div className="min-h-screen bg-[#0F1117]">
      {/* Top breadcrumb bar */}
      <div className="bg-[#1A1D27] border-b border-[#2A2D3A] px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/projects"
            className="text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Progetti
          </Link>
          <span className="text-gray-600">/</span>
          <span className="text-gray-300 font-medium">
            {loading ? '...' : project?.name || 'Untitled'}
          </span>
          <span className="text-gray-600">/</span>
          <span className="text-white font-semibold">{sectionLabel}</span>
        </div>
      </div>

      <div className="flex">
        {/* In-page sidebar */}
        <aside className="w-60 bg-[#1A1D27] border-r border-[#2A2D3A] min-h-[calc(100vh-49px)] py-4 sticky top-0">
          {/* Project header in sidebar */}
          <div className="px-4 pb-4 mb-2 border-b border-[#2A2D3A] flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#2A2D3A] flex items-center justify-center text-sm font-bold text-gray-300 uppercase flex-shrink-0">
              {(project?.name || 'U').charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white truncate">
                {loading ? 'Loading...' : project?.name || 'Untitled'}
              </div>
              {project?.domain && (
                <div className="text-[11px] text-gray-500 truncate">{project.domain}</div>
              )}
            </div>
          </div>

          <nav className="px-2">
            <ul className="space-y-0.5">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const active = section === s.key;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => pickSection(s.key)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                        active
                          ? 'bg-emerald-900/30 text-emerald-300 font-medium'
                          : 'text-gray-400 hover:bg-[#0F1117] hover:text-white'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 text-left truncate">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-6 max-w-[1100px]">
          {section === 'general_brief' && (
            <GeneralBriefSection projectId={id} />
          )}
          {section === 'funnel' && (
            <FunnelSection projectId={id} />
          )}
          {section !== 'general_brief' && section !== 'funnel' && (
            <ComingSoonSection
              label={sectionLabel}
              icon={SECTIONS.find((s) => s.key === section)?.icon || FileText}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── General Brief section ───────────────────────────────────────────────────

function GeneralBriefSection({ projectId }: { projectId: string }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>('general'); // 'general' = the static "General Brief" tab
  const [editingId, setEditingId] = useState<string | null>(null);

  // Hydrate tabs from localStorage on mount.
  useEffect(() => {
    const loaded = loadTabs(projectId);
    setTabs(loaded);
    if (loaded.length > 0) setActiveId(loaded[0].id);
  }, [projectId]);

  function persist(next: Tab[]) {
    setTabs(next);
    saveTabs(projectId, next);
  }

  function addTab() {
    const name = prompt('Nome della nuova scheda (es. "Product Brief — OTO1")')?.trim();
    if (!name) return;
    const t: Tab = { id: uid(), name, color: suggestColor(name) };
    const next = [...tabs, t];
    persist(next);
    setActiveId(t.id);
  }

  function renameTab(tabId: string, name: string) {
    const next = tabs.map((t) => (t.id === tabId ? { ...t, name, color: suggestColor(name) } : t));
    persist(next);
    setEditingId(null);
  }

  function removeTab(tabId: string) {
    if (!confirm('Eliminare questa scheda? Documenti e immagini caricati andranno persi.')) return;
    const next = tabs.filter((t) => t.id !== tabId);
    persist(next);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(tabContentKey(projectId, tabId));
    }
    if (activeId === tabId) {
      setActiveId(next[0]?.id || 'general');
    }
  }

  const isGeneralActive = activeId === 'general';
  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <div className="space-y-4">
      {/* Tabs row */}
      <div className="bg-[#1A1D27] rounded-xl border border-[#2A2D3A] px-2 py-1 flex items-center gap-1 overflow-x-auto">
        {/* Static "General Brief" tab */}
        <TabButton
          active={isGeneralActive}
          onClick={() => setActiveId('general')}
          color="slate"
          icon={<FileText className="w-4 h-4" />}
          label="General Brief"
        />
        {tabs.map((t, i) => (
          <TabButton
            key={t.id}
            active={activeId === t.id}
            onClick={() => setActiveId(t.id)}
            color={t.color}
            badge={String(i + 1)}
            label={t.name}
            editable
            isEditing={editingId === t.id}
            onStartEdit={() => setEditingId(t.id)}
            onCommitEdit={(value) => renameTab(t.id, value)}
            onRemove={() => removeTab(t.id)}
          />
        ))}
        <button
          type="button"
          onClick={addTab}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/20 rounded-md transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
          Aggiungi
        </button>
      </div>

      {/* Active tab content */}
      {isGeneralActive ? (
        <GeneralBriefContent />
      ) : activeTab ? (
        <ProductBriefTab
          projectId={projectId}
          tab={activeTab}
        />
      ) : (
        <div className="text-center text-gray-400 py-20 bg-[#1A1D27] rounded-xl border border-[#2A2D3A]">
          Nessuna scheda selezionata. Premi <strong className="text-white">+ Aggiungi</strong> per crearne una.
        </div>
      )}
    </div>
  );
}

// ─── Tab button ──────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  color,
  badge,
  icon,
  label,
  editable = false,
  isEditing = false,
  onStartEdit,
  onCommitEdit,
  onRemove,
}: {
  active: boolean;
  onClick: () => void;
  color: Tab['color'];
  badge?: string;
  icon?: React.ReactNode;
  label: string;
  editable?: boolean;
  isEditing?: boolean;
  onStartEdit?: () => void;
  onCommitEdit?: (value: string) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(label);
  useEffect(() => { setDraft(label); }, [label, isEditing]);
  const cls = TAB_COLOR[color];

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer transition-colors flex-shrink-0 border-b-2 ${
        active
          ? `${cls.underline} text-white font-semibold`
          : 'border-transparent text-gray-400 hover:bg-[#0F1117] hover:text-gray-200'
      }`}
      onClick={() => !isEditing && onClick()}
    >
      {badge && (
        <span className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${cls.badge}`}>
          {badge}
        </span>
      )}
      {icon}
      {isEditing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitEdit?.(draft.trim() || label)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommitEdit?.(draft.trim() || label);
            if (e.key === 'Escape') onCommitEdit?.(label);
          }}
          className="bg-[#0F1117] border border-[#2A2D3A] outline-none px-1.5 py-0.5 rounded text-sm text-white min-w-0 max-w-[200px] focus:border-blue-500"
        />
      ) : (
        <span className="whitespace-nowrap">{label}</span>
      )}
      {editable && active && !isEditing && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStartEdit?.(); }}
            className="p-0.5 text-gray-500 hover:text-white transition-colors"
            title="Rinomina"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove?.(); }}
            className="p-0.5 text-gray-500 hover:text-red-400 transition-colors"
            title="Elimina scheda"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

// ─── Static "General Brief" placeholder content ──────────────────────────────

function GeneralBriefContent() {
  return (
    <div className="bg-[#1A1D27] rounded-xl border border-[#2A2D3A] p-10 text-center text-gray-400">
      <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
      <h3 className="text-base font-semibold text-gray-200">General Brief</h3>
      <p className="text-sm mt-1">
        Brief generale del progetto. Per i brief specifici di ogni step funnel,
        usa le schede a destra (Product Brief — Frontend, OTO1, OTO2, …).
      </p>
    </div>
  );
}

// ─── Product Brief tab content ───────────────────────────────────────────────

function ProductBriefTab({ projectId, tab }: { projectId: string; tab: Tab }) {
  const [content, setContent] = useState<TabContent>({});
  useEffect(() => {
    setContent(loadTabContent(projectId, tab.id));
  }, [projectId, tab.id]);

  function persist(next: TabContent) {
    setContent(next);
    saveTabContent(projectId, tab.id, next);
  }

  return (
    <div className="space-y-4">
      {/* Color pill above the cards */}
      <div>
        <span
          className={`inline-block px-3 py-1.5 rounded-full text-xs font-semibold text-white ${
            TAB_COLOR[tab.color].pill
          }`}
        >
          {tab.name}
        </span>
      </div>

      {/* Mockup Immagini Prodotto — placed ABOVE per user's request
          ("sopra il + aggiungi le foto") */}
      <ImagesCard
        title="Mockup Immagini Prodotto"
        subtitle="Carica le foto del prodotto per questo step del funnel"
        images={content.images || []}
        onChange={(images) => persist({ ...content, images })}
      />

      {/* Product Brief document upload */}
      <DocumentCard
        title="Product Brief"
        subtitle="Carica il product brief per questo step del funnel"
        document={content.document}
        onChange={(document) => persist({ ...content, document })}
      />
    </div>
  );
}

// ─── Document upload card ────────────────────────────────────────────────────

function DocumentCard({
  title,
  subtitle,
  document: doc,
  onChange,
}: {
  title: string;
  subtitle: string;
  document?: DocumentFile;
  onChange: (next: DocumentFile | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataURL(file);
      onChange({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        dataUrl,
        uploadedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Card title={title} icon={<FileText className="w-4 h-4 text-gray-300" />} action={
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-200 bg-[#0F1117] border border-[#2A2D3A] rounded-md hover:bg-[#222530] hover:border-[#3A3D4A] transition-colors disabled:opacity-50"
      >
        <Upload className="w-3.5 h-3.5" />
        {busy ? 'Carico...' : 'Aggiungi documento'}
      </button>
    }>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx,.txt,.md,.rtf,.odt"
        onChange={handleFile}
        className="hidden"
      />
      {doc ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border border-[#2A2D3A] rounded-lg bg-[#0F1117]">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-lg bg-blue-900/30 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-blue-400" />
            </div>
            <div className="min-w-0">
              <a
                href={doc.dataUrl}
                download={doc.name}
                className="block text-sm font-medium text-white truncate hover:text-blue-400"
              >
                {doc.name}
              </a>
              <div className="text-xs text-gray-500 mt-0.5">
                {formatBytes(doc.size)} · caricato {new Date(doc.uploadedAt).toLocaleString('it-IT')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors flex-shrink-0"
            title="Rimuovi"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <EmptyState icon={<FileText className="w-8 h-8" />} title="Nessun documento caricato" subtitle={subtitle} />
      )}
    </Card>
  );
}

// ─── Images upload card ──────────────────────────────────────────────────────

function ImagesCard({
  title,
  subtitle,
  images,
  onChange,
}: {
  title: string;
  subtitle: string;
  images: ImageFile[];
  onChange: (next: ImageFile[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy(true);
    try {
      const next: ImageFile[] = [...images];
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const dataUrl = await readFileAsDataURL(file);
        next.push({
          name: file.name,
          size: file.size,
          dataUrl,
          uploadedAt: new Date().toISOString(),
        });
      }
      onChange(next);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function removeAt(idx: number) {
    onChange(images.filter((_, i) => i !== idx));
  }

  return (
    <Card title={title} icon={<ImageIcon className="w-4 h-4 text-gray-300" />} action={
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-200 bg-[#0F1117] border border-[#2A2D3A] rounded-md hover:bg-[#222530] hover:border-[#3A3D4A] transition-colors disabled:opacity-50"
      >
        <Upload className="w-3.5 h-3.5" />
        {busy ? 'Carico...' : 'Aggiungi immagini'}
      </button>
    }>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFiles}
        className="hidden"
      />
      {images.length === 0 ? (
        <EmptyState icon={<ImageIcon className="w-8 h-8" />} title="Nessuna immagine caricata" subtitle={subtitle} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {images.map((img, idx) => (
            <div key={idx} className="group relative border border-[#2A2D3A] rounded-lg overflow-hidden bg-[#0F1117]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt={img.name}
                className="w-full aspect-square object-cover"
              />
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="absolute top-1.5 right-1.5 p-1 bg-[#1A1D27]/95 text-gray-300 hover:text-red-400 rounded-md shadow-sm opacity-0 group-hover:opacity-100 transition-opacity border border-[#2A2D3A]"
                title="Rimuovi"
              >
                <X className="w-3.5 h-3.5" />
              </button>
              <div className="px-2 py-1.5 text-[11px] text-gray-400 truncate" title={img.name}>
                {img.name}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Generic Card / EmptyState ───────────────────────────────────────────────

function Card({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-[#1A1D27] rounded-xl border border-[#2A2D3A] overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[#2A2D3A]">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          {icon}
          {title}
        </h3>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="border-2 border-dashed border-[#2A2D3A] rounded-lg py-12 px-4 text-center text-gray-500">
      <div className="w-12 h-12 mx-auto mb-3 bg-[#0F1117] rounded-lg flex items-center justify-center text-gray-500">
        {icon}
      </div>
      <p className="text-sm italic font-medium text-gray-300">{title}</p>
      <p className="text-xs mt-1 text-gray-500">{subtitle}</p>
    </div>
  );
}

// ─── Funnel section: reuse existing flows list ───────────────────────────────

function FunnelSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { loadFlows(); }, [projectId]);

  async function loadFlows() {
    setLoading(true);
    const { data } = await supabase
      .from('funnel_flows')
      .select('id, name, status, is_active, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (data) {
      setFlows(data.map((f: any) => ({
        id: String(f.id || ''),
        name: typeof f.name === 'string' ? f.name : 'Flow',
        status: typeof f.status === 'string' ? f.status : 'draft',
        is_active: Boolean(f.is_active),
        created_at: typeof f.created_at === 'string' ? f.created_at : '',
      })));
    }
    setLoading(false);
  }

  async function addFlow() {
    if (!newName.trim()) return;
    setAdding(true);
    const { data, error } = await supabase
      .from('funnel_flows')
      .insert({ project_id: projectId, name: newName.trim(), status: 'draft', is_active: false })
      .select('id, name, status, is_active, created_at')
      .single();
    if (error) {
      alert(`Create failed: ${error.message}`);
      setAdding(false);
      return;
    }
    if (data) {
      setFlows((prev) => [{
        id: String(data.id),
        name: String(data.name || ''),
        status: String(data.status || 'draft'),
        is_active: Boolean(data.is_active),
        created_at: String(data.created_at || ''),
      }, ...prev]);
      setNewName('');
      setShowAdd(false);
    }
    setAdding(false);
  }

  async function deleteFlow(flowId: string) {
    if (!confirm('Delete this flow and all its steps?')) return;
    await supabase.from('funnel_flows').delete().eq('id', flowId);
    setFlows((prev) => prev.filter((f) => f.id !== flowId));
  }

  return (
    <Card
      title={`Flows (${flows.length})`}
      icon={<Layers className="w-4 h-4 text-gray-300" />}
      action={
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
        >
          {showAdd ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          {showAdd ? 'Annulla' : 'Aggiungi flow'}
        </button>
      }
    >
      {showAdd && (
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFlow()}
            placeholder="Flow name (es. Flow A — Nooro Swipe)"
            className="flex-1 bg-[#0F1117] border border-[#2A2D3A] rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <button
            onClick={addFlow}
            disabled={adding || !newName.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
          >
            {adding ? 'Creo...' : 'Crea'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-8 animate-pulse text-sm">Carico flows...</div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={<Layers className="w-8 h-8" />}
          title="Nessun flow ancora creato"
          subtitle="Aggiungi il primo flow per iniziare"
        />
      ) : (
        <ul className="divide-y divide-[#2A2D3A]">
          {flows.map((flow) => (
            <li key={flow.id} className="flex items-center justify-between gap-3 py-3">
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}/flow/${flow.id}`)}
                className="flex items-center gap-3 min-w-0 flex-1 text-left group"
              >
                <div className="w-9 h-9 rounded-lg bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                  <Layers className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white truncate group-hover:text-blue-400">{flow.name}</div>
                  <div className="text-xs text-gray-500">
                    {flow.created_at ? new Date(flow.created_at).toLocaleDateString('it-IT') : ''}
                    {flow.is_active && <span className="ml-2 text-emerald-400">· active</span>}
                  </div>
                </div>
              </button>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-700 text-gray-300">
                {flow.status}
              </span>
              <Link
                href={`/projects/${projectId}/flow/${flow.id}`}
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1"
              >
                Apri <ChevronRight className="w-3.5 h-3.5" />
              </Link>
              <button
                onClick={() => deleteFlow(flow.id)}
                className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                title="Elimina"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Coming soon placeholder ─────────────────────────────────────────────────

function ComingSoonSection({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <Card title={label} icon={<Icon className="w-4 h-4 text-gray-300" />}>
      <EmptyState
        icon={<Icon className="w-8 h-8" />}
        title={`${label} — in arrivo`}
        subtitle="Questa sezione sarà disponibile a breve."
      />
    </Card>
  );
}
