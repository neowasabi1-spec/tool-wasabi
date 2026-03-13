'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import { createClient } from '@supabase/supabase-js';
import type { AffiliateSavedFunnel, Json } from '@/types/database';
import {
  Search,
  FlipVertical,
  Loader2,
  ChevronDown,
  ChevronRight,
  Target,
  Brain,
  Zap,
  MessageSquare,
  ArrowRight,
  Shield,
  Sparkles,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Eye,
  Heart,
  Users,
  Award,
  BarChart3,
  Globe,
  CheckCircle2,
  XCircle,
  ChevronUp,
  Upload,
  Link2,
  Image as ImageIcon,
  FileText,
  StickyNote,
  Plus,
  X,
  Database,
  Download,
  ExternalLink,
  Wand2,
  Layout,
  ArrowUpRight,
} from 'lucide-react';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ─── Types ───────────────────────────────────────────────

interface FunnelStep {
  step_index: number;
  url?: string;
  title?: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

interface StepAnalysis {
  step_index: number;
  step_name: string;
  step_type: string;
  unique_mechanism: string;
  objective: string;
  psychological_triggers: string[];
  copywriting_framework: string;
  hook: string;
  angle: string;
  bridge_to_next: string;
  conversion_elements: {
    primary_cta: string;
    cta_style: string;
    secondary_ctas: string[];
    form_elements: string[];
    trust_signals: string[];
  };
  objections_handled: string[];
  micro_commitments: string[];
  emotional_state: {
    entry_emotion: string;
    exit_emotion: string;
  };
  effectiveness_notes: string;
}

interface FunnelOverview {
  funnel_architecture: string;
  global_unique_mechanism: string;
  big_promise: string;
  target_avatar: string;
  awareness_level: string;
  sophistication_level: string;
  customer_journey_emotions: string[];
  overall_effectiveness_score: number;
  copy_score: number;
  design_score: number;
  persuasion_score: number;
  flow_score: number;
  cta_score: number;
  strengths: string[];
  weaknesses: string[];
  optimization_suggestions: string[];
}

interface RegeneratedStep {
  step_index: number;
  step_name: string;
  step_type: string;
  headline: string;
  subheadline: string;
  body_copy: string;
  cta_text: string;
  key_elements: string[];
  why_improved: string;
}

interface RegeneratedFunnel {
  concept: string;
  improvements_applied: string[];
  steps: RegeneratedStep[];
}

interface ReverseAnalysis {
  funnel_overview: FunnelOverview;
  steps_analysis: StepAnalysis[];
  regenerated_funnel?: RegeneratedFunnel;
}

interface UploadedFile {
  data: string;
  name: string;
  size: number;
}

type InputMode = 'saved' | 'upload';
type AnalysisTab = 'overview' | 'steps' | 'visual' | 'json';

// ─── Helpers ─────────────────────────────────────────────

function parseSteps(raw: Json): FunnelStep[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as FunnelStep[];
}

async function compressImage(file: File, maxWidth = 1600): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ratio = Math.min(maxWidth / img.width, 1);
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas not supported')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ─── Small Components ────────────────────────────────────

function ScoreBar({ score, label, color }: { score: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-1000"
          style={{ width: `${score * 10}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-bold text-slate-700 w-8 text-right">{score}/10</span>
    </div>
  );
}

function EmotionJourney({ emotions }: { emotions: string[] }) {
  if (!emotions || emotions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {emotions.map((emotion, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 font-medium">
            {emotion}
          </span>
          {i < emotions.length - 1 && (
            <ArrowRight className="h-3 w-3 text-violet-300 shrink-0" />
          )}
        </span>
      ))}
    </div>
  );
}

const STEP_TYPE_ICONS: Record<string, { icon: typeof Target; color: string; bg: string }> = {
  landing: { icon: Globe, color: '#3b82f6', bg: '#eff6ff' },
  quiz_question: { icon: Brain, color: '#8b5cf6', bg: '#f5f3ff' },
  lead_capture: { icon: Users, color: '#14b8a6', bg: '#f0fdfa' },
  checkout: { icon: Award, color: '#10b981', bg: '#ecfdf5' },
  upsell: { icon: TrendingUp, color: '#f59e0b', bg: '#fffbeb' },
  info_screen: { icon: Eye, color: '#3b82f6', bg: '#f0f9ff' },
  thank_you: { icon: Heart, color: '#22c55e', bg: '#f0fdf4' },
  other: { icon: Zap, color: '#94a3b8', bg: '#f8fafc' },
};

function DropZone({
  accept,
  onFiles,
  icon: Icon,
  label,
  sublabel,
}: {
  accept: string;
  onFiles: (files: FileList) => void;
  icon: typeof Upload;
  label: string;
  sublabel: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        onFiles(e.dataTransfer.files);
      }
    },
    [onFiles]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
        isDragging
          ? 'border-indigo-400 bg-indigo-50 scale-[1.02]'
          : 'border-slate-200 hover:border-indigo-300 hover:bg-slate-50'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => e.target.files && onFiles(e.target.files)}
      />
      <Icon className={`h-6 w-6 mx-auto mb-1.5 ${isDragging ? 'text-indigo-500' : 'text-slate-300'}`} />
      <p className={`text-xs font-medium ${isDragging ? 'text-indigo-600' : 'text-slate-500'}`}>{label}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">{sublabel}</p>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────

export default function ReverseFunnelPage() {
  // Input mode
  const [inputMode, setInputMode] = useState<InputMode>('upload');

  // Saved funnel state
  const [funnels, setFunnels] = useState<AffiliateSavedFunnel[]>([]);
  const [loadingFunnels, setLoadingFunnels] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFunnel, setSelectedFunnel] = useState<AffiliateSavedFunnel | null>(null);

  // Upload state
  const [uploadLinks, setUploadLinks] = useState<string[]>([]);
  const [linkInput, setLinkInput] = useState('');
  const [uploadImages, setUploadImages] = useState<UploadedFile[]>([]);
  const [uploadDocuments, setUploadDocuments] = useState<UploadedFile[]>([]);
  const [uploadNotes, setUploadNotes] = useState('');
  const [funnelName, setFunnelName] = useState('');
  const [processingFiles, setProcessingFiles] = useState(false);

  // Analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<ReverseAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<AnalysisTab>('overview');
  const [modelUsed, setModelUsed] = useState<string>('');

  // Visual generation state
  const [generatingVisual, setGeneratingVisual] = useState(false);
  const [visualHtml, setVisualHtml] = useState<string | null>(null);

  useEffect(() => {
    loadFunnels();
  }, []);

  async function loadFunnels() {
    setLoadingFunnels(true);
    const { data, error: err } = await supabase
      .from('affiliate_saved_funnels')
      .select('*')
      .order('created_at', { ascending: false });
    if (!err) setFunnels(data ?? []);
    setLoadingFunnels(false);
  }

  // ─── File Handlers ───────────────────────────────────

  async function handleImageFiles(files: FileList) {
    setProcessingFiles(true);
    try {
      const newImages: UploadedFile[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const compressed = await compressImage(file);
        newImages.push({ data: compressed, name: file.name, size: file.size });
      }
      setUploadImages((prev) => [...prev, ...newImages]);
    } finally {
      setProcessingFiles(false);
    }
  }

  function handleDocumentFiles(files: FileList) {
    setProcessingFiles(true);
    const newDocs: UploadedFile[] = [];
    let pending = 0;

    Array.from(files).forEach((file) => {
      if (!file.type.includes('pdf') && !file.type.includes('document')) return;
      pending++;
      const reader = new FileReader();
      reader.onload = (e) => {
        newDocs.push({ data: e.target?.result as string, name: file.name, size: file.size });
        pending--;
        if (pending === 0) {
          setUploadDocuments((prev) => [...prev, ...newDocs]);
          setProcessingFiles(false);
        }
      };
      reader.readAsDataURL(file);
    });

    if (pending === 0) setProcessingFiles(false);
  }

  function addLink() {
    const url = linkInput.trim();
    if (!url) return;
    const normalized = url.startsWith('http') ? url : `https://${url}`;
    if (!uploadLinks.includes(normalized)) {
      setUploadLinks((prev) => [...prev, normalized]);
    }
    setLinkInput('');
  }

  // ─── Analysis ────────────────────────────────────────

  async function runAnalysis() {
    setAnalyzing(true);
    setError(null);
    setAnalysis(null);
    setVisualHtml(null);
    setExpandedSteps(new Set());
    setActiveTab('overview');

    try {
      const payload: Record<string, unknown> = {};

      if (inputMode === 'saved' && selectedFunnel) {
        payload.funnel = {
          funnel_name: selectedFunnel.funnel_name,
          brand_name: selectedFunnel.brand_name,
          entry_url: selectedFunnel.entry_url,
          funnel_type: selectedFunnel.funnel_type,
          category: selectedFunnel.category,
          tags: selectedFunnel.tags,
          total_steps: selectedFunnel.total_steps,
          steps: selectedFunnel.steps,
          analysis_summary: selectedFunnel.analysis_summary,
          persuasion_techniques: selectedFunnel.persuasion_techniques,
          lead_capture_method: selectedFunnel.lead_capture_method,
          notable_elements: selectedFunnel.notable_elements,
        };
      } else {
        payload.materials = {
          funnelName: funnelName || undefined,
          links: uploadLinks.length > 0 ? uploadLinks : undefined,
          images:
            uploadImages.length > 0
              ? uploadImages.map((img) => ({ data: img.data, name: img.name }))
              : undefined,
          documents:
            uploadDocuments.length > 0
              ? uploadDocuments.map((doc) => ({ data: doc.data, name: doc.name }))
              : undefined,
          notes: uploadNotes.trim() || undefined,
        };
      }

      const res = await fetch('/api/reverse-funnel/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || 'Error during analysis');
        return;
      }

      setAnalysis(data.analysis as ReverseAnalysis);
      setModelUsed(data.model || 'gpt-4.1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setAnalyzing(false);
    }
  }

  async function generateVisual() {
    if (!analysis) return;
    setGeneratingVisual(true);
    try {
      const name =
        inputMode === 'saved'
          ? selectedFunnel?.funnel_name
          : funnelName || 'Analyzed Funnel';

      const res = await fetch('/api/reverse-funnel/generate-visual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis, funnelName: name }),
      });

      const data = await res.json();
      if (data.success) {
        setVisualHtml(data.html);
        setActiveTab('visual');
      } else {
        setError(data.error || 'Error in visual generation');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setGeneratingVisual(false);
    }
  }

  function downloadVisualHtml() {
    if (!visualHtml) return;
    const blob = new Blob([visualHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `regenerated-funnel-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── UI Helpers ──────────────────────────────────────

  function toggleStep(idx: number) {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function expandAllSteps() {
    if (!analysis) return;
    setExpandedSteps(new Set(analysis.steps_analysis.map((_, i) => i)));
  }

  function collapseAllSteps() {
    setExpandedSteps(new Set());
  }

  const filteredFunnels = funnels.filter((f) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      f.funnel_name.toLowerCase().includes(q) ||
      (f.brand_name?.toLowerCase().includes(q) ?? false) ||
      f.entry_url.toLowerCase().includes(q) ||
      f.funnel_type.toLowerCase().includes(q) ||
      f.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const hasUploadMaterials =
    uploadLinks.length > 0 ||
    uploadImages.length > 0 ||
    uploadDocuments.length > 0 ||
    uploadNotes.trim().length > 0;

  const canAnalyze =
    inputMode === 'saved' ? !!selectedFunnel : hasUploadMaterials;

  const currentFunnelName =
    inputMode === 'saved'
      ? selectedFunnel?.funnel_name ?? ''
      : funnelName || 'Uploaded Materials';

  // ─── Render ──────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Reverse Funnel"
        subtitle="AI analysis with reverse engineering — GPT-4.1 Vision + Multimodal"
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto flex gap-6">
          {/* ═══ LEFT PANEL ═══ */}
          <div className="w-[420px] shrink-0 space-y-3">
            {/* Mode Switcher */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-1 flex gap-1">
              <button
                onClick={() => setInputMode('upload')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                  inputMode === 'upload'
                    ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload Materials
              </button>
              <button
                onClick={() => setInputMode('saved')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                  inputMode === 'saved'
                    ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                <Database className="h-3.5 w-3.5" />
                Saved Funnels
              </button>
            </div>

            {/* ─── Upload Mode ─── */}
            {inputMode === 'upload' && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-violet-50">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-indigo-600" />
                    <h2 className="text-sm font-bold text-slate-800">Funnel Materials</h2>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Upload links, screenshots, PDFs and notes for AI analysis
                  </p>
                </div>

                <div className="p-4 space-y-4 max-h-[calc(100vh-320px)] overflow-y-auto">
                  {/* Funnel Name */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mb-1.5">
                      <Target className="h-3 w-3 text-indigo-500" />
                      Funnel Name (optional)
                    </label>
                    <input
                      type="text"
                      value={funnelName}
                      onChange={(e) => setFunnelName(e.target.value)}
                      placeholder="E.g. Quiz Funnel Skincare..."
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    />
                  </div>

                  {/* Links */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mb-1.5">
                      <Link2 className="h-3 w-3 text-blue-500" />
                      Page Links ({uploadLinks.length})
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={linkInput}
                        onChange={(e) => setLinkInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addLink()}
                        placeholder="https://example.com/funnel"
                        className="flex-1 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                      />
                      <button
                        onClick={addLink}
                        disabled={!linkInput.trim()}
                        className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-40"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {uploadLinks.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {uploadLinks.map((link, i) => (
                          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-blue-50 rounded-lg border border-blue-100">
                            <Globe className="h-3 w-3 text-blue-500 shrink-0" />
                            <span className="text-[10px] text-blue-700 truncate flex-1">{link}</span>
                            <button
                              onClick={() => setUploadLinks((prev) => prev.filter((_, j) => j !== i))}
                              className="text-blue-400 hover:text-red-500 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Screenshots */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mb-1.5">
                      <ImageIcon className="h-3 w-3 text-emerald-500" />
                      Screenshot ({uploadImages.length})
                    </label>
                    <DropZone
                      accept="image/*"
                      onFiles={handleImageFiles}
                      icon={ImageIcon}
                      label="Drag screenshots here"
                      sublabel="JPG, PNG, WebP — max 1600px"
                    />
                    {uploadImages.length > 0 && (
                      <div className="mt-2 grid grid-cols-3 gap-1.5">
                        {uploadImages.map((img, i) => (
                          <div key={i} className="relative group rounded-lg overflow-hidden border border-slate-200">
                            <img
                              src={img.data}
                              alt={img.name}
                              className="w-full h-16 object-cover"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                              <button
                                onClick={() => setUploadImages((prev) => prev.filter((_, j) => j !== i))}
                                className="opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 text-white rounded-full p-1"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                              <p className="text-[8px] text-white truncate">{img.name}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Documents */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mb-1.5">
                      <FileText className="h-3 w-3 text-orange-500" />
                      PDF Documents ({uploadDocuments.length})
                    </label>
                    <DropZone
                      accept=".pdf,.doc,.docx"
                      onFiles={handleDocumentFiles}
                      icon={FileText}
                      label="Drag PDFs here"
                      sublabel="PDF, DOC, DOCX"
                    />
                    {uploadDocuments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {uploadDocuments.map((doc, i) => (
                          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-orange-50 rounded-lg border border-orange-100">
                            <FileText className="h-3 w-3 text-orange-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-orange-700 truncate">{doc.name}</p>
                              <p className="text-[9px] text-orange-400">{formatBytes(doc.size)}</p>
                            </div>
                            <button
                              onClick={() => setUploadDocuments((prev) => prev.filter((_, j) => j !== i))}
                              className="text-orange-400 hover:text-red-500 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 mb-1.5">
                      <StickyNote className="h-3 w-3 text-amber-500" />
                      Additional Notes
                    </label>
                    <textarea
                      value={uploadNotes}
                      onChange={(e) => setUploadNotes(e.target.value)}
                      placeholder="Add context, observations, details about the funnel..."
                      rows={3}
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none resize-none"
                    />
                  </div>

                  {/* Upload Stats */}
                  {hasUploadMaterials && (
                    <div className="flex items-center flex-wrap gap-2 pt-1">
                      {uploadLinks.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600 border border-blue-100">
                          <Link2 className="h-2.5 w-2.5" /> {uploadLinks.length} link
                        </span>
                      )}
                      {uploadImages.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-600 border border-emerald-100">
                          <ImageIcon className="h-2.5 w-2.5" /> {uploadImages.length} images
                        </span>
                      )}
                      {uploadDocuments.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-50 text-orange-600 border border-orange-100">
                          <FileText className="h-2.5 w-2.5" /> {uploadDocuments.length} documents
                        </span>
                      )}
                    </div>
                  )}

                  {/* Analyze Button */}
                  <button
                    onClick={runAnalysis}
                    disabled={!canAnalyze || analyzing || processingFiles}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-xl font-semibold text-sm hover:from-indigo-700 hover:to-violet-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-200"
                  >
                    {analyzing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Analyzing with GPT-4.1...
                      </>
                    ) : processingFiles ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processing files...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        Analyze with GPT-4.1 Vision
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* ─── Saved Funnels Mode ─── */}
            {inputMode === 'saved' && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden sticky top-0">
                <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-violet-50">
                  <div className="flex items-center gap-2 mb-3">
                    <FlipVertical className="h-5 w-5 text-indigo-600" />
                    <h2 className="text-sm font-bold text-slate-800">Select Funnel</h2>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search funnels..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    />
                  </div>
                </div>

                <div className="max-h-[calc(100vh-380px)] overflow-y-auto">
                  {loadingFunnels ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-5 w-5 text-slate-400 animate-spin" />
                    </div>
                  ) : filteredFunnels.length === 0 ? (
                    <div className="text-center py-12 px-4">
                      <FlipVertical className="h-8 w-8 text-slate-200 mx-auto" />
                      <p className="mt-2 text-xs text-slate-400">No funnels found</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {filteredFunnels.map((funnel) => {
                        const isSelected = selectedFunnel?.id === funnel.id;
                        const steps = parseSteps(funnel.steps);
                        return (
                          <button
                            key={funnel.id}
                            onClick={() => setSelectedFunnel(funnel)}
                            className={`w-full text-left px-4 py-3 transition-colors ${
                              isSelected
                                ? 'bg-indigo-50 border-l-2 border-indigo-500'
                                : 'hover:bg-slate-50 border-l-2 border-transparent'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-semibold truncate ${isSelected ? 'text-indigo-700' : 'text-slate-700'}`}>
                                  {funnel.funnel_name}
                                </p>
                                {funnel.brand_name && (
                                  <p className="text-[10px] text-slate-400 mt-0.5">{funnel.brand_name}</p>
                                )}
                                <div className="flex items-center gap-2 mt-1.5">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                                    {funnel.funnel_type.replace(/_/g, ' ')}
                                  </span>
                                  <span className="text-[10px] text-slate-400">{steps.length} step</span>
                                </div>
                              </div>
                              {isSelected && <ChevronRight className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {selectedFunnel && (
                  <div className="p-3 border-t border-slate-100">
                    <button
                      onClick={runAnalysis}
                      disabled={analyzing}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-lg font-semibold text-sm hover:from-indigo-700 hover:to-violet-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                    >
                      {analyzing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Analyzing...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" />
                          Analyze with GPT-4.1
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ═══ RIGHT PANEL ═══ */}
          <div className="flex-1 min-w-0">
            {/* Empty State */}
            {!analysis && !analyzing && !error && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center min-h-[500px]">
                <div className="text-center px-8">
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center mx-auto">
                    <FlipVertical className="h-10 w-10 text-indigo-500" />
                  </div>
                  <h3 className="mt-5 text-xl font-bold text-slate-700">Reverse Funnel Engineering</h3>
                  <p className="mt-2 text-sm text-slate-400 max-w-lg">
                    {inputMode === 'upload'
                      ? 'Upload links, screenshots, PDFs or any funnel material. GPT-4.1 Vision will analyze everything in depth with reverse engineering.'
                      : 'Select a funnel from the list to analyze it with AI. GPT-4.1 will analyze every step identifying the unique mechanism, psychological triggers and more.'}
                  </p>
                  <div className="mt-6 flex items-center justify-center gap-3">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-100">
                      <Brain className="h-3 w-3" /> GPT-4.1 Vision
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-violet-50 text-violet-600 border border-violet-100">
                      <ImageIcon className="h-3 w-3" /> Multimodal
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600 border border-emerald-100">
                      <Layout className="h-3 w-3" /> Visual
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-3 mb-4">
                <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-red-700">Analysis error</p>
                  <p className="text-xs text-red-600 mt-0.5">{error}</p>
                </div>
                <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Loading */}
            {analyzing && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center py-24">
                <div className="text-center">
                  <div className="relative">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center mx-auto animate-pulse">
                      <Brain className="h-10 w-10 text-indigo-500" />
                    </div>
                    <div className="absolute -top-1 -right-1 w-7 h-7 bg-amber-400 rounded-full flex items-center justify-center animate-bounce">
                      <Sparkles className="h-3.5 w-3.5 text-white" />
                    </div>
                  </div>
                  <p className="mt-5 text-base font-bold text-slate-700">Reverse Engineering in progress...</p>
                  <p className="mt-1 text-sm text-slate-400">
                    GPT-4.1 is analyzing {inputMode === 'upload' ? 'the uploaded materials' : 'every funnel step'}
                  </p>
                  {inputMode === 'upload' && (
                    <div className="mt-3 flex items-center justify-center flex-wrap gap-2">
                      {uploadLinks.length > 0 && (
                        <span className="text-[10px] text-blue-500">
                          Retrieving {uploadLinks.length} links...
                        </span>
                      )}
                      {uploadImages.length > 0 && (
                        <span className="text-[10px] text-emerald-500">
                          Analyzing {uploadImages.length} images...
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mt-4 flex items-center justify-center gap-1">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"
                        style={{ animationDelay: `${i * 200}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Analysis Results */}
            {analysis && !analyzing && (
              <div className="space-y-4">
                {/* Funnel Header */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 px-5 py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-white font-bold text-lg">{currentFunnelName}</h3>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="inline-flex items-center gap-1 text-indigo-200 text-xs">
                            <Sparkles className="h-3 w-3" /> {modelUsed}
                          </span>
                          {analysis.steps_analysis && (
                            <span className="text-indigo-200 text-xs">
                              {analysis.steps_analysis.length} step analizzati
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!visualHtml && (
                          <button
                            onClick={generateVisual}
                            disabled={generatingVisual}
                            className="flex items-center gap-2 px-4 py-2.5 bg-white/20 backdrop-blur-sm text-white rounded-lg font-semibold text-sm hover:bg-white/30 transition-colors disabled:opacity-50 border border-white/20"
                          >
                            {generatingVisual ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Generando...
                              </>
                            ) : (
                              <>
                                <Layout className="h-4 w-4" />
                                Generate Visual
                              </>
                            )}
                          </button>
                        )}
                        <button
                          onClick={runAnalysis}
                          disabled={analyzing}
                          className="flex items-center gap-2 px-4 py-2.5 bg-white text-indigo-700 rounded-lg font-semibold text-sm hover:bg-indigo-50 transition-colors disabled:opacity-50 shadow-sm"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                          Re-Analyze
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Steps Preview (only for saved funnel mode) */}
                  {inputMode === 'saved' && selectedFunnel && (
                    <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                        {parseSteps(selectedFunnel.steps).map((step, i) => {
                          const typeInfo = STEP_TYPE_ICONS[step.step_type ?? 'other'] ?? STEP_TYPE_ICONS.other;
                          const Icon = typeInfo.icon;
                          return (
                            <span key={i} className="flex items-center gap-1">
                              <span
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium whitespace-nowrap border"
                                style={{ backgroundColor: typeInfo.bg, color: typeInfo.color, borderColor: typeInfo.color + '30' }}
                              >
                                <Icon className="h-2.5 w-2.5" />
                                {step.title || `Step ${step.step_index}`}
                              </span>
                              {i < parseSteps(selectedFunnel.steps).length - 1 && (
                                <ArrowRight className="h-3 w-3 text-slate-300 shrink-0" />
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1 bg-white rounded-xl border border-slate-200 p-1 shadow-sm">
                  {(
                    [
                      { key: 'overview', label: 'Global Overview' },
                      { key: 'steps', label: 'Step Analysis' },
                      { key: 'visual', label: 'Regenerated Funnel', badge: !visualHtml },
                      { key: 'json', label: 'JSON Raw' },
                    ] as { key: AnalysisTab; label: string; badge?: boolean }[]
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => {
                        if (tab.key === 'visual' && !visualHtml && !generatingVisual) {
                          generateVisual();
                        }
                        setActiveTab(tab.key);
                      }}
                      className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors relative ${
                        activeTab === tab.key
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      {tab.label}
                      {tab.key === 'visual' && !visualHtml && !generatingVisual && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full" />
                      )}
                    </button>
                  ))}
                </div>

                {/* ═══ OVERVIEW TAB ═══ */}
                {activeTab === 'overview' && analysis.funnel_overview && (
                  <div className="space-y-4">
                    {/* Big Mechanism & Promise */}
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-orange-50">
                        <div className="flex items-center gap-2">
                          <Target className="h-4 w-4 text-amber-600" />
                          <h4 className="text-sm font-bold text-slate-800">Global Unique Mechanism</h4>
                        </div>
                      </div>
                      <div className="p-5 space-y-4">
                        <div>
                          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Unique Mechanism</p>
                          <p className="text-sm text-slate-700 leading-relaxed">{analysis.funnel_overview.global_unique_mechanism}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Big Promise</p>
                          <p className="text-sm text-slate-700 leading-relaxed">{analysis.funnel_overview.big_promise}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Target Avatar</p>
                            <p className="text-sm text-slate-700">{analysis.funnel_overview.target_avatar}</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Architecture</p>
                            <p className="text-sm text-slate-700">{analysis.funnel_overview.funnel_architecture}</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Awareness Level</p>
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                              {analysis.funnel_overview.awareness_level}
                            </span>
                          </div>
                          <div>
                            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Market Sophistication</p>
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">
                              Level {analysis.funnel_overview.sophistication_level}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Customer Journey */}
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-purple-50">
                        <div className="flex items-center gap-2">
                          <Heart className="h-4 w-4 text-violet-600" />
                          <h4 className="text-sm font-bold text-slate-800">Emotional Customer Journey</h4>
                        </div>
                      </div>
                      <div className="p-5">
                        <EmotionJourney emotions={analysis.funnel_overview.customer_journey_emotions} />
                      </div>
                    </div>

                    {/* Scores */}
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-teal-50">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-4 w-4 text-emerald-600" />
                          <h4 className="text-sm font-bold text-slate-800">Effectiveness Scoring</h4>
                        </div>
                      </div>
                      <div className="p-5">
                        <div className="flex items-center gap-4 mb-5">
                          <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg">
                            <span className="text-2xl font-black text-white">
                              {analysis.funnel_overview.overall_effectiveness_score}
                            </span>
                          </div>
                          <div>
                            <p className="text-lg font-bold text-slate-800">Overall Score</p>
                            <p className="text-xs text-slate-400">Overall funnel effectiveness</p>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <ScoreBar score={analysis.funnel_overview.copy_score} label="Copywriting" color="#8b5cf6" />
                          <ScoreBar score={analysis.funnel_overview.design_score} label="Design" color="#3b82f6" />
                          <ScoreBar score={analysis.funnel_overview.persuasion_score} label="Persuasion" color="#f59e0b" />
                          <ScoreBar score={analysis.funnel_overview.flow_score} label="Flow/UX" color="#10b981" />
                          <ScoreBar score={analysis.funnel_overview.cta_score} label="CTA" color="#ef4444" />
                        </div>
                      </div>
                    </div>

                    {/* Strengths & Weaknesses */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-green-50">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            <h4 className="text-sm font-bold text-slate-800">Strengths</h4>
                          </div>
                        </div>
                        <div className="p-4 space-y-2">
                          {analysis.funnel_overview.strengths?.map((s, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                              <p className="text-xs text-slate-600 leading-relaxed">{s}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-red-50 to-orange-50">
                          <div className="flex items-center gap-2">
                            <XCircle className="h-4 w-4 text-red-500" />
                            <h4 className="text-sm font-bold text-slate-800">Weaknesses</h4>
                          </div>
                        </div>
                        <div className="p-4 space-y-2">
                          {analysis.funnel_overview.weaknesses?.map((w, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                              <p className="text-xs text-slate-600 leading-relaxed">{w}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Optimization */}
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-sky-50 to-blue-50">
                        <div className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4 text-sky-600" />
                          <h4 className="text-sm font-bold text-slate-800">Optimization Suggestions</h4>
                        </div>
                      </div>
                      <div className="p-4 space-y-2">
                        {analysis.funnel_overview.optimization_suggestions?.map((s, i) => (
                          <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-sky-50/50">
                            <Lightbulb className="h-3.5 w-3.5 text-sky-500 shrink-0 mt-0.5" />
                            <p className="text-xs text-slate-600 leading-relaxed">{s}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Regenerated Funnel Preview (inline) */}
                    {analysis.regenerated_funnel && (
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-purple-50">
                          <div className="flex items-center gap-2">
                            <Wand2 className="h-4 w-4 text-indigo-600" />
                            <h4 className="text-sm font-bold text-slate-800">Regenerated Funnel — Concept</h4>
                          </div>
                        </div>
                        <div className="p-5 space-y-4">
                          <p className="text-sm text-slate-700 leading-relaxed">
                            {analysis.regenerated_funnel.concept}
                          </p>
                          {analysis.regenerated_funnel.improvements_applied?.length > 0 && (
                            <div>
                              <p className="text-xs text-slate-400 uppercase tracking-wider mb-2">Improvements Applied</p>
                              <div className="flex flex-wrap gap-1.5">
                                {analysis.regenerated_funnel.improvements_applied.map((imp, i) => (
                                  <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                                    <ArrowUpRight className="h-2.5 w-2.5" />
                                    {imp}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Mini step cards */}
                          <div className="space-y-2">
                            {analysis.regenerated_funnel.steps?.map((step, i) => {
                              const typeInfo = STEP_TYPE_ICONS[step.step_type ?? 'other'] ?? STEP_TYPE_ICONS.other;
                              const Icon = typeInfo.icon;
                              return (
                                <div
                                  key={i}
                                  className="p-3 rounded-lg border border-slate-200 bg-gradient-to-r from-white to-slate-50"
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    <div
                                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
                                      style={{ backgroundColor: typeInfo.bg }}
                                    >
                                      <Icon className="h-3 w-3" style={{ color: typeInfo.color }} />
                                    </div>
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: typeInfo.color }}>
                                      STEP {step.step_index}
                                    </span>
                                    <span className="text-xs font-semibold text-slate-700">{step.step_name}</span>
                                  </div>
                                  <div className="ml-8 space-y-1">
                                    <p className="text-xs font-bold text-indigo-700">{step.headline}</p>
                                    {step.subheadline && (
                                      <p className="text-[11px] text-slate-500">{step.subheadline}</p>
                                    )}
                                    {step.cta_text && (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700">
                                        CTA: {step.cta_text}
                                      </span>
                                    )}
                                    {step.why_improved && (
                                      <p className="text-[10px] text-indigo-500 italic mt-1">{step.why_improved}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ STEPS TAB ═══ */}
                {activeTab === 'steps' && analysis.steps_analysis && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-400">{analysis.steps_analysis.length} steps analyzed</p>
                      <div className="flex items-center gap-2">
                        <button onClick={expandAllSteps} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1">
                          <ChevronDown className="h-3 w-3" /> Expand all
                        </button>
                        <button onClick={collapseAllSteps} className="text-xs text-slate-400 hover:text-slate-600 font-medium flex items-center gap-1">
                          <ChevronUp className="h-3 w-3" /> Collapse all
                        </button>
                      </div>
                    </div>

                    {analysis.steps_analysis.map((step, idx) => {
                      const isExpanded = expandedSteps.has(idx);
                      const typeInfo = STEP_TYPE_ICONS[step.step_type ?? 'other'] ?? STEP_TYPE_ICONS.other;
                      const Icon = typeInfo.icon;

                      return (
                        <div key={idx} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                          <button
                            onClick={() => toggleStep(idx)}
                            className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                          >
                            <div
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                              style={{ backgroundColor: typeInfo.bg }}
                            >
                              <Icon className="h-4 w-4" style={{ color: typeInfo.color }} />
                            </div>
                            <div className="flex-1 text-left min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: typeInfo.color }}>
                                  STEP {step.step_index}
                                </span>
                                <span className="text-sm font-semibold text-slate-700 truncate">{step.step_name}</span>
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5 truncate">{step.unique_mechanism}</p>
                            </div>
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                            )}
                          </button>

                          {isExpanded && (
                            <div className="px-5 pb-5 border-t border-slate-100 space-y-4 pt-4">
                              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <Target className="h-3.5 w-3.5 text-amber-600" />
                                  <p className="text-xs font-bold text-amber-800">Unique Mechanism</p>
                                </div>
                                <p className="text-xs text-amber-700 leading-relaxed">{step.unique_mechanism}</p>
                              </div>

                              <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Objective</p>
                                <p className="text-xs text-slate-700 leading-relaxed">{step.objective}</p>
                              </div>

                              <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200">
                                  <p className="text-[10px] text-indigo-500 uppercase tracking-wider mb-1">Hook</p>
                                  <p className="text-xs text-indigo-800 font-medium">{step.hook}</p>
                                </div>
                                <div className="p-3 rounded-lg bg-violet-50 border border-violet-200">
                                  <p className="text-[10px] text-violet-500 uppercase tracking-wider mb-1">Angle</p>
                                  <p className="text-xs text-violet-800 font-medium">{step.angle}</p>
                                </div>
                              </div>

                              <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Copywriting Framework</p>
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">
                                  <MessageSquare className="h-3 w-3" />
                                  {step.copywriting_framework}
                                </span>
                              </div>

                              <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Psychological Triggers</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {step.psychological_triggers?.map((t, i) => (
                                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-50 text-rose-700 border border-rose-200">
                                      <Brain className="h-2.5 w-2.5" />
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              </div>

                              {step.emotional_state && (
                                <div className="flex items-center gap-3 p-3 rounded-lg bg-violet-50 border border-violet-200">
                                  <div className="text-center">
                                    <p className="text-[9px] text-violet-500 uppercase tracking-wider">Entry</p>
                                    <p className="text-xs font-semibold text-violet-700 mt-0.5">{step.emotional_state.entry_emotion}</p>
                                  </div>
                                  <ArrowRight className="h-4 w-4 text-violet-400 shrink-0" />
                                  <div className="text-center">
                                    <p className="text-[9px] text-violet-500 uppercase tracking-wider">Exit</p>
                                    <p className="text-xs font-semibold text-violet-700 mt-0.5">{step.emotional_state.exit_emotion}</p>
                                  </div>
                                </div>
                              )}

                              {step.conversion_elements && (
                                <div>
                                  <p className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Conversion Elements</p>
                                  <div className="space-y-2">
                                    {step.conversion_elements.primary_cta && (
                                      <div className="flex items-center gap-2">
                                        <Zap className="h-3 w-3 text-emerald-500" />
                                        <span className="text-xs text-slate-600">
                                          CTA: <span className="font-semibold text-emerald-700">{step.conversion_elements.primary_cta}</span>
                                        </span>
                                      </div>
                                    )}
                                    {step.conversion_elements.trust_signals?.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {step.conversion_elements.trust_signals.map((ts, i) => (
                                          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">
                                            <Shield className="h-2.5 w-2.5" />
                                            {ts}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {step.objections_handled?.length > 0 && (
                                <div>
                                  <p className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Objections Handled</p>
                                  <div className="space-y-1">
                                    {step.objections_handled.map((obj, i) => (
                                      <div key={i} className="flex items-start gap-2">
                                        <Shield className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
                                        <p className="text-xs text-slate-600">{obj}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {step.micro_commitments?.length > 0 && (
                                <div>
                                  <p className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Micro-Commitments</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {step.micro_commitments.map((mc, i) => (
                                      <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-sky-50 text-sky-700 border border-sky-200">
                                        <CheckCircle2 className="h-2.5 w-2.5" />
                                        {mc}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {step.bridge_to_next && (
                                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                                  <div className="flex items-center gap-2 mb-1">
                                    <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
                                    <p className="text-xs font-bold text-slate-600">Transition to Next Step</p>
                                  </div>
                                  <p className="text-xs text-slate-500 leading-relaxed">{step.bridge_to_next}</p>
                                </div>
                              )}

                              {step.effectiveness_notes && (
                                <div className="p-3 rounded-lg bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200">
                                  <div className="flex items-center gap-2 mb-1">
                                    <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
                                    <p className="text-xs font-bold text-emerald-700">Effectiveness Notes</p>
                                  </div>
                                  <p className="text-xs text-emerald-600 leading-relaxed">{step.effectiveness_notes}</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ═══ VISUAL TAB ═══ */}
                {activeTab === 'visual' && (
                  <div className="space-y-3">
                    {generatingVisual && (
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center py-20">
                        <div className="text-center">
                          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center mx-auto animate-pulse">
                            <Layout className="h-8 w-8 text-indigo-500" />
                          </div>
                          <p className="mt-4 text-sm font-semibold text-slate-700">Generating visual mockup...</p>
                          <p className="mt-1 text-xs text-slate-400">GPT-4.1 is creating the regenerated funnel layout</p>
                          <div className="mt-4 flex items-center justify-center gap-1">
                            {[0, 1, 2, 3, 4].map((i) => (
                              <div
                                key={i}
                                className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"
                                style={{ animationDelay: `${i * 200}ms` }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {visualHtml && !generatingVisual && (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Layout className="h-4 w-4 text-indigo-600" />
                            <p className="text-sm font-semibold text-slate-700">Regenerated Funnel Mockup</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={generateVisual}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                            >
                              <ArrowUpRight className="h-3 w-3" />
                              Regenerate
                            </button>
                            <button
                              onClick={downloadVisualHtml}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                            >
                              <Download className="h-3 w-3" />
                              Download HTML
                            </button>
                            <button
                              onClick={() => {
                                const w = window.open('', '_blank');
                                if (w) { w.document.write(visualHtml); w.document.close(); }
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open in Tab
                            </button>
                          </div>
                        </div>

                        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                          <iframe
                            srcDoc={visualHtml}
                            className="w-full border-0"
                            style={{ height: '700px' }}
                            sandbox="allow-scripts allow-same-origin"
                            title="Regenerated Funnel Preview"
                          />
                        </div>
                      </>
                    )}

                    {!visualHtml && !generatingVisual && (
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center py-20">
                        <div className="text-center px-8">
                          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center mx-auto">
                            <Layout className="h-8 w-8 text-indigo-500" />
                          </div>
                          <h4 className="mt-4 text-base font-bold text-slate-700">Visual Mockup</h4>
                          <p className="mt-2 text-xs text-slate-400 max-w-md">
                            Generate an interactive HTML mockup of the regenerated funnel based on the analysis.
                          </p>
                          <button
                            onClick={generateVisual}
                            className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-lg font-semibold text-sm hover:from-indigo-700 hover:to-violet-700 transition-all shadow-lg shadow-indigo-200"
                          >
                            <Wand2 className="h-4 w-4" />
                            Generate Mockup
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ JSON TAB ═══ */}
                {activeTab === 'json' && (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                      <h4 className="text-sm font-bold text-slate-800">JSON Response</h4>
                      <button
                        onClick={() => navigator.clipboard.writeText(JSON.stringify(analysis, null, 2))}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                      >
                        Copy JSON
                      </button>
                    </div>
                    <pre className="p-5 text-xs text-slate-600 overflow-auto max-h-[600px] bg-slate-50 font-mono leading-relaxed">
                      {JSON.stringify(analysis, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
