'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Header from '@/components/Header';
import FunnelFlowView from '@/components/FunnelFlowView';
import { fetchAffiliateSavedFunnels, deleteAffiliateSavedFunnel, createAffiliateSavedFunnel, createArchivedFunnel } from '@/lib/supabase-operations';
import { useStore } from '@/store/useStore';
import type { AffiliateSavedFunnel, Json } from '@/types/database';
import {
  Filter,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Trash2,
  Tag,
  Calendar,
  FileStack,
  Loader2,
  AlertCircle,
  Sparkles,
  X,
  Zap,
  Target,
  Search,
  Globe,
  ShieldCheck,
  Lightbulb,
  LayoutList,
  Eye,
  CheckSquare,
  Square,
  CheckCircle2,
  Circle,
  MousePointerClick,
  ClipboardList,
  ListChecks,
  Repeat,
  Workflow,
  Save,
  Plus,
  PlusCircle,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Copy,
  Edit3,
  Archive,
} from 'lucide-react';

/* ───────── helpers ───────── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

const FUNNEL_TYPE_LABELS: Record<string, string> = {
  quiz_funnel: 'Quiz Funnel',
  sales_funnel: 'Sales Funnel',
  landing_page: 'Landing Page',
  webinar_funnel: 'Webinar Funnel',
  tripwire_funnel: 'Tripwire Funnel',
  lead_magnet: 'Lead Magnet',
  vsl_funnel: 'VSL Funnel',
  other: 'Other',
};

const CATEGORY_LABELS: Record<string, string> = {
  weight_loss: 'Weight Loss',
  supplements: 'Supplements',
  skincare: 'Skincare',
  fitness: 'Fitness',
  finance: 'Finance',
  saas: 'SaaS',
  ecommerce: 'E-commerce',
  health: 'Health',
  education: 'Education',
  other: 'Other',
};

const FUNNEL_TYPE_COLORS: Record<string, string> = {
  quiz_funnel: 'bg-violet-100 text-violet-800',
  sales_funnel: 'bg-emerald-100 text-emerald-800',
  landing_page: 'bg-sky-100 text-sky-800',
  webinar_funnel: 'bg-rose-100 text-rose-800',
  tripwire_funnel: 'bg-amber-100 text-amber-800',
  lead_magnet: 'bg-teal-100 text-teal-800',
  vsl_funnel: 'bg-orange-100 text-orange-800',
  other: 'bg-slate-100 text-slate-700',
};

const STEP_TYPE_LABELS: Record<string, string> = {
  quiz_question: 'Quiz Question',
  info_screen: 'Info Screen',
  lead_capture: 'Lead Capture',
  checkout: 'Checkout',
  upsell: 'Upsell',
  thank_you: 'Thank You',
  landing: 'Landing',
  other: 'Other',
};

const STEP_TYPE_COLORS: Record<string, string> = {
  quiz_question: 'bg-violet-100 text-violet-700',
  info_screen: 'bg-sky-100 text-sky-700',
  lead_capture: 'bg-teal-100 text-teal-700',
  checkout: 'bg-emerald-100 text-emerald-700',
  upsell: 'bg-amber-100 text-amber-700',
  thank_you: 'bg-green-100 text-green-700',
  landing: 'bg-blue-100 text-blue-700',
  other: 'bg-slate-100 text-slate-600',
};

type TabId = 'all' | 'quiz';

interface SavedFunnelStep {
  step_index: number;
  url?: string;
  title?: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

function parseSteps(raw: Json): SavedFunnelStep[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as SavedFunnelStep[];
}

export interface SelectedItem {
  funnelId: string;
  funnelName: string;
  type: 'full_funnel' | 'single_page';
  stepIndex?: number;
  stepTitle?: string;
  stepUrl?: string;
}

/* ───────── component ───────── */

export default function MyFunnelsPage() {
  const [funnels, setFunnels] = useState<AffiliateSavedFunnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [detailFunnel, setDetailFunnel] = useState<AffiliateSavedFunnel | null>(null);
  const [flowFunnel, setFlowFunnel] = useState<AffiliateSavedFunnel | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  /* ── Tabs ── */
  const [activeTab, setActiveTab] = useState<TabId>('all');

  /* ── Filters ── */
  const [searchText, setSearchText] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  /* ── Selection state ── */
  const [selectedFunnelIds, setSelectedFunnelIds] = useState<Set<string>>(new Set());
  const [selectedPages, setSelectedPages] = useState<Map<string, Set<number>>>(new Map());

  /* ── Tab counts ── */
  const allCount = funnels.length;
  const quizCount = useMemo(() => funnels.filter((f) => f.funnel_type === 'quiz_funnel').length, [funnels]);

  /* ── Tab-level filtering ── */
  const tabFiltered = useMemo(() => {
    if (activeTab === 'quiz') return funnels.filter((f) => f.funnel_type === 'quiz_funnel');
    return funnels;
  }, [funnels, activeTab]);

  const uniqueTypes = useMemo(() => {
    const set = new Set(tabFiltered.map((f) => f.funnel_type));
    return Array.from(set).sort();
  }, [tabFiltered]);

  const uniqueCategories = useMemo(() => {
    const set = new Set(tabFiltered.map((f) => f.category));
    return Array.from(set).sort();
  }, [tabFiltered]);

  /* ── Full filtering (tab + text + dropdown) ── */
  const filtered = useMemo(() => {
    return tabFiltered.filter((f) => {
      if (filterType !== 'all' && f.funnel_type !== filterType) return false;
      if (filterCategory !== 'all' && f.category !== filterCategory) return false;
      if (searchText.trim()) {
        const q = searchText.toLowerCase();
        const matchName = f.funnel_name.toLowerCase().includes(q);
        const matchBrand = f.brand_name?.toLowerCase().includes(q);
        const matchUrl = f.entry_url.toLowerCase().includes(q);
        const matchTags = f.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchName && !matchBrand && !matchUrl && !matchTags) return false;
      }
      return true;
    });
  }, [tabFiltered, filterType, filterCategory, searchText]);

  /* ═══════════ Selection helpers ═══════════ */

  const isFunnelFullySelected = useCallback(
    (id: string) => selectedFunnelIds.has(id),
    [selectedFunnelIds],
  );

  const isStepSelected = useCallback(
    (funnelId: string, stepIndex: number) => {
      if (selectedFunnelIds.has(funnelId)) return true;
      return selectedPages.get(funnelId)?.has(stepIndex) ?? false;
    },
    [selectedFunnelIds, selectedPages],
  );

  const toggleSelectFunnel = useCallback(
    (funnel: AffiliateSavedFunnel) => {
      setSelectedFunnelIds((prev) => {
        const next = new Set(prev);
        if (next.has(funnel.id)) {
          next.delete(funnel.id);
        } else {
          next.add(funnel.id);
          setSelectedPages((sp) => {
            const nextSp = new Map(sp);
            nextSp.delete(funnel.id);
            return nextSp;
          });
        }
        return next;
      });
    },
    [],
  );

  const toggleSelectStep = useCallback(
    (funnelId: string, stepIndex: number) => {
      if (selectedFunnelIds.has(funnelId)) {
        const funnel = funnels.find((f) => f.id === funnelId);
        if (!funnel) return;
        const steps = parseSteps(funnel.steps);
        const allIndices = new Set(steps.map((s) => s.step_index));
        allIndices.delete(stepIndex);
        setSelectedFunnelIds((prev) => {
          const next = new Set(prev);
          next.delete(funnelId);
          return next;
        });
        setSelectedPages((prev) => {
          const next = new Map(prev);
          if (allIndices.size > 0) {
            next.set(funnelId, allIndices);
          } else {
            next.delete(funnelId);
          }
          return next;
        });
        return;
      }

      setSelectedPages((prev) => {
        const next = new Map(prev);
        const current = new Set(next.get(funnelId) ?? []);
        if (current.has(stepIndex)) {
          current.delete(stepIndex);
        } else {
          current.add(stepIndex);
        }
        if (current.size === 0) {
          next.delete(funnelId);
        } else {
          next.set(funnelId, current);
        }
        return next;
      });
    },
    [selectedFunnelIds, funnels],
  );

  const clearSelection = useCallback(() => {
    setSelectedFunnelIds(new Set());
    setSelectedPages(new Map());
  }, []);

  /* ── Derived selection info ── */
  const selectedItems = useMemo<SelectedItem[]>(() => {
    const items: SelectedItem[] = [];
    for (const fid of selectedFunnelIds) {
      const funnel = funnels.find((f) => f.id === fid);
      if (funnel) {
        items.push({ funnelId: funnel.id, funnelName: funnel.funnel_name, type: 'full_funnel' });
      }
    }
    for (const [fid, indices] of selectedPages) {
      const funnel = funnels.find((f) => f.id === fid);
      if (!funnel) continue;
      const steps = parseSteps(funnel.steps);
      for (const idx of indices) {
        const step = steps.find((s) => s.step_index === idx);
        items.push({
          funnelId: funnel.id,
          funnelName: funnel.funnel_name,
          type: 'single_page',
          stepIndex: idx,
          stepTitle: step?.title || `Step ${idx}`,
          stepUrl: step?.url,
        });
      }
    }
    return items;
  }, [selectedFunnelIds, selectedPages, funnels]);

  const totalSelectedFunnels = selectedFunnelIds.size;
  const totalSelectedPages = useMemo(() => {
    let count = 0;
    for (const s of selectedPages.values()) count += s.size;
    return count;
  }, [selectedPages]);
  const hasSelection = totalSelectedFunnels > 0 || totalSelectedPages > 0;

  /* ═══════════ Data loading ═══════════ */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAffiliateSavedFunnels()
      .then((data) => {
        if (!cancelled) setFunnels(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Error loading data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setFilterType('all');
  }, [activeTab]);

  /* ═══════════ Handlers ═══════════ */

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDelete = async (funnel: AffiliateSavedFunnel) => {
    if (!confirm(`Delete "${funnel.funnel_name}"?`)) return;
    setDeletingId(funnel.id);
    try {
      await deleteAffiliateSavedFunnel(funnel.id);
      setFunnels((prev) => prev.filter((f) => f.id !== funnel.id));
      if (detailFunnel?.id === funnel.id) setDetailFunnel(null);
      setSelectedFunnelIds((prev) => {
        const next = new Set(prev);
        next.delete(funnel.id);
        return next;
      });
      setSelectedPages((prev) => {
        const next = new Map(prev);
        next.delete(funnel.id);
        return next;
      });
    } catch (err) {
      setError((err as Error)?.message ?? 'Error during deletion');
    } finally {
      setDeletingId(null);
    }
  };

  const handleImportToArchive = async (funnel: AffiliateSavedFunnel) => {
    setArchivingId(funnel.id);
    try {
      const steps = parseSteps(funnel.steps);
      const archiveSteps = steps.map((s, i) => ({
        step_index: i + 1,
        name: s.title || `Step ${i + 1}`,
        page_type: s.step_type || 'other',
        url_to_swipe: s.url || '',
        prompt: '',
        template_name: '',
        product_name: funnel.brand_name || '',
        swipe_status: 'pending',
        swipe_result: '',
      }));
      const created = await createArchivedFunnel({
        name: funnel.funnel_name,
        total_steps: archiveSteps.length,
        steps: archiveSteps as unknown as Json,
      });
      useStore.setState((state) => ({
        archivedFunnels: [created, ...state.archivedFunnels],
        archivedFunnelsLoaded: true,
      }));
      alert(`"${funnel.funnel_name}" imported to My Archive!`);
    } catch (err) {
      setError((err as Error)?.message ?? 'Error importing to archive');
    } finally {
      setArchivingId(null);
    }
  };

  /* ═══════════ Save-as-new-funnel modal state ═══════════ */

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveForm, setSaveForm] = useState({
    funnel_name: '',
    funnel_type: 'quiz_funnel',
    category: 'other',
    brand_name: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const collectedSteps = useMemo<SavedFunnelStep[]>(() => {
    const result: SavedFunnelStep[] = [];

    for (const fid of selectedFunnelIds) {
      const funnel = funnels.find((f) => f.id === fid);
      if (!funnel) continue;
      const steps = parseSteps(funnel.steps);
      result.push(...steps);
    }

    for (const [fid, indices] of selectedPages) {
      const funnel = funnels.find((f) => f.id === fid);
      if (!funnel) continue;
      const steps = parseSteps(funnel.steps);
      for (const idx of indices) {
        const step = steps.find((s) => s.step_index === idx);
        if (step) result.push(step);
      }
    }

    return result.map((s, i) => ({ ...s, step_index: i + 1 }));
  }, [selectedFunnelIds, selectedPages, funnels]);

  const openSaveModal = useCallback(() => {
    const firstSourceFunnel =
      (selectedFunnelIds.size > 0
        ? funnels.find((f) => f.id === [...selectedFunnelIds][0])
        : null) ??
      (selectedPages.size > 0
        ? funnels.find((f) => f.id === [...selectedPages.keys()][0])
        : null);

    setSaveForm({
      funnel_name: '',
      funnel_type: firstSourceFunnel?.funnel_type ?? 'quiz_funnel',
      category: firstSourceFunnel?.category ?? 'other',
      brand_name: firstSourceFunnel?.brand_name ?? '',
    });
    setSaveSuccess(null);
    setShowSaveModal(true);
  }, [selectedFunnelIds, selectedPages, funnels]);

  const handleSaveAsNewFunnel = useCallback(async () => {
    if (!saveForm.funnel_name.trim() || collectedSteps.length === 0) return;
    setSaving(true);
    setSaveSuccess(null);
    try {
      const entryUrl = collectedSteps[0]?.url || '';
      const tags = [...new Set(
        [...selectedFunnelIds, ...selectedPages.keys()]
          .map((fid) => funnels.find((f) => f.id === fid))
          .filter(Boolean)
          .flatMap((f) => f!.tags),
      )];
      const persuasion = [...new Set(
        [...selectedFunnelIds, ...selectedPages.keys()]
          .map((fid) => funnels.find((f) => f.id === fid))
          .filter(Boolean)
          .flatMap((f) => f!.persuasion_techniques),
      )];
      const notableElements = [...new Set(
        [...selectedFunnelIds, ...selectedPages.keys()]
          .map((fid) => funnels.find((f) => f.id === fid))
          .filter(Boolean)
          .flatMap((f) => f!.notable_elements),
      )];

      const newFunnel = await createAffiliateSavedFunnel({
        funnel_name: saveForm.funnel_name.trim(),
        funnel_type: saveForm.funnel_type,
        category: saveForm.category,
        brand_name: saveForm.brand_name.trim() || null,
        entry_url: entryUrl,
        total_steps: collectedSteps.length,
        steps: collectedSteps as unknown as import('@/types/database').Json,
        tags,
        persuasion_techniques: persuasion,
        notable_elements: notableElements,
        analysis_summary: `Funnel composed of ${collectedSteps.length} manually selected steps.`,
        raw_agent_result: 'manually_composed',
      });

      setFunnels((prev) => [newFunnel, ...prev]);
      clearSelection();
      setSaveSuccess(newFunnel.funnel_name);
      setTimeout(() => {
        setShowSaveModal(false);
        setSaveSuccess(null);
      }, 1500);
    } catch (err) {
      setError((err as Error)?.message ?? 'Error during save');
    } finally {
      setSaving(false);
    }
  }, [saveForm, collectedSteps, selectedFunnelIds, selectedPages, funnels, clearSelection]);

  /* ═══════════ Create from scratch modal state ═══════════ */

  interface ScratchStep {
    id: string;
    title: string;
    url: string;
    step_type: string;
    description: string;
    cta_text: string;
    options: string[];
    input_type: string;
  }

  const emptyScratchStep = (): ScratchStep => ({
    id: crypto.randomUUID(),
    title: '',
    url: '',
    step_type: 'landing',
    description: '',
    cta_text: '',
    options: [],
    input_type: 'none',
  });

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    funnel_name: '',
    funnel_type: 'sales_funnel',
    category: 'other',
    brand_name: '',
    entry_url: '',
    analysis_summary: '',
    tags: '' as string,
    persuasion_techniques: '' as string,
    notable_elements: '' as string,
    lead_capture_method: 'none',
  });
  const [scratchSteps, setScratchSteps] = useState<ScratchStep[]>([emptyScratchStep()]);
  const [editingStepOptionIdx, setEditingStepOptionIdx] = useState<{ stepId: string; text: string } | null>(null);

  const openCreateModal = useCallback(() => {
    setCreateForm({
      funnel_name: '',
      funnel_type: 'sales_funnel',
      category: 'other',
      brand_name: '',
      entry_url: '',
      analysis_summary: '',
      tags: '',
      persuasion_techniques: '',
      notable_elements: '',
      lead_capture_method: 'none',
    });
    setScratchSteps([emptyScratchStep()]);
    setCreateSuccess(null);
    setShowCreateModal(true);
  }, []);

  const addScratchStep = useCallback(() => {
    setScratchSteps((prev) => [...prev, emptyScratchStep()]);
  }, []);

  const removeScratchStep = useCallback((id: string) => {
    setScratchSteps((prev) => prev.length > 1 ? prev.filter((s) => s.id !== id) : prev);
  }, []);

  const updateScratchStep = useCallback((id: string, field: keyof ScratchStep, value: unknown) => {
    setScratchSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
    );
  }, []);

  const duplicateScratchStep = useCallback((id: string) => {
    setScratchSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx === -1) return prev;
      const clone = { ...prev[idx], id: crypto.randomUUID() };
      const next = [...prev];
      next.splice(idx + 1, 0, clone);
      return next;
    });
  }, []);

  const moveScratchStep = useCallback((id: string, direction: 'up' | 'down') => {
    setScratchSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx === -1) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
      return next;
    });
  }, []);

  const addOptionToStep = useCallback((stepId: string, option: string) => {
    if (!option.trim()) return;
    setScratchSteps((prev) =>
      prev.map((s) =>
        s.id === stepId ? { ...s, options: [...s.options, option.trim()] } : s,
      ),
    );
  }, []);

  const removeOptionFromStep = useCallback((stepId: string, optIdx: number) => {
    setScratchSteps((prev) =>
      prev.map((s) =>
        s.id === stepId
          ? { ...s, options: s.options.filter((_, i) => i !== optIdx) }
          : s,
      ),
    );
  }, []);

  const handleCreateFromScratch = useCallback(async () => {
    if (!createForm.funnel_name.trim()) return;
    setCreateSaving(true);
    setCreateSuccess(null);
    try {
      const stepsPayload = scratchSteps.map((s, i) => ({
        step_index: i + 1,
        title: s.title.trim() || `Step ${i + 1}`,
        url: s.url.trim(),
        step_type: s.step_type,
        description: s.description.trim(),
        cta_text: s.cta_text.trim(),
        options: s.options,
        input_type: s.input_type,
      }));

      const splitTrim = (str: string) =>
        str
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

      const newFunnel = await createAffiliateSavedFunnel({
        funnel_name: createForm.funnel_name.trim(),
        funnel_type: createForm.funnel_type,
        category: createForm.category,
        brand_name: createForm.brand_name.trim() || null,
        entry_url: createForm.entry_url.trim() || stepsPayload[0]?.url || '',
        total_steps: stepsPayload.length,
        steps: stepsPayload as unknown as import('@/types/database').Json,
        tags: splitTrim(createForm.tags),
        persuasion_techniques: splitTrim(createForm.persuasion_techniques),
        notable_elements: splitTrim(createForm.notable_elements),
        lead_capture_method: createForm.lead_capture_method !== 'none' ? createForm.lead_capture_method : null,
        analysis_summary: createForm.analysis_summary.trim() || `Funnel template manually created with ${stepsPayload.length} steps.`,
        raw_agent_result: 'manually_created',
      });

      setFunnels((prev) => [newFunnel, ...prev]);
      setCreateSuccess(newFunnel.funnel_name);
      setTimeout(() => {
        setShowCreateModal(false);
        setCreateSuccess(null);
      }, 1500);
    } catch (err) {
      setError((err as Error)?.message ?? 'Error during creation');
    } finally {
      setCreateSaving(false);
    }
  }, [createForm, scratchSteps]);

  const TABS: { id: TabId; label: string; count: number; icon: typeof Target }[] = [
    { id: 'all', label: 'All Funnels', count: allCount, icon: Target },
    { id: 'quiz', label: 'Quiz Funnel', count: quizCount, icon: ListChecks },
  ];

  /* ═══════════ Render ═══════════ */

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-50/80 via-orange-50/40 to-slate-50">
      <Header
        title="My Funnels"
        subtitle="Saved and analyzed funnels — select individual pages or entire funnels"
      />

      <div className={`p-6 ${hasSelection ? 'pb-32' : ''}`}>
        {/* ══ Tabs ══ */}
        {!loading && !error && funnels.length > 0 && (
          <div className="mb-6 flex items-center gap-1 rounded-xl bg-white border border-slate-200 p-1 shadow-sm w-fit">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-amber-500 text-white shadow-md'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                  <span
                    className={`ml-1 rounded-full px-2 py-0.5 text-xs font-bold ${
                      isActive ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* ══ Hero strip ══ */}
        {!loading && !error && funnels.length > 0 && (
          <div className="mb-6 rounded-2xl bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-600/5 border border-amber-200/60 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20">
                  {activeTab === 'quiz' ? (
                    <ListChecks className="h-7 w-7 text-amber-700" />
                  ) : (
                    <Target className="h-7 w-7 text-amber-700" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">
                    {filtered.length} {activeTab === 'quiz' ? 'quiz ' : ''}funnel{filtered.length === 1 ? '' : 's'} found
                  </h2>
                  <p className="text-sm text-slate-600 mt-0.5">
                    {activeTab === 'quiz'
                      ? 'Quiz funnels with analyzed steps, questions and options — click to select'
                      : 'Select an entire funnel or individual pages to use them'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {hasSelection && (
                  <div className="flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-2 border border-amber-300/60">
                    <MousePointerClick className="h-4 w-4 text-amber-700" />
                    <span className="text-sm font-medium text-amber-800">
                      {totalSelectedFunnels > 0 && `${totalSelectedFunnels} funnel`}
                      {totalSelectedFunnels > 0 && totalSelectedPages > 0 && ' + '}
                      {totalSelectedPages > 0 &&
                        `${totalSelectedPages} page${totalSelectedPages === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={openCreateModal}
                  className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:bg-emerald-400 transition-colors"
                >
                  <PlusCircle className="h-4 w-4" />
                  Create Funnel from Scratch
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ Filters bar ══ */}
        {!loading && !error && funnels.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by name, brand, URL or tag..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
              />
            </div>

            {activeTab === 'all' && (
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
              >
                <option value="all">All types</option>
                {uniqueTypes.map((t) => (
                  <option key={t} value={t}>
                    {FUNNEL_TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            )}

            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
            >
              <option value="all">All categories</option>
              {uniqueCategories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c] ?? c}
                </option>
              ))}
            </select>

            {(filterType !== 'all' || filterCategory !== 'all' || searchText) && (
              <button
                onClick={() => {
                  setFilterType('all');
                  setFilterCategory('all');
                  setSearchText('');
                }}
                className="text-xs text-slate-500 hover:text-amber-600 underline"
              >
                Reset filters
              </button>
            )}
          </div>
        )}

        {/* ══ Loading ══ */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-24">
            <Loader2 className="h-12 w-12 text-amber-500 animate-spin" />
            <p className="mt-4 text-slate-500">Loading funnels...</p>
          </div>
        )}

        {/* ══ Error ══ */}
        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ══ Empty state ══ */}
        {!loading && !error && funnels.length === 0 && (
          <div className="rounded-2xl border border-amber-200/60 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-100">
              <Filter className="h-10 w-10 text-amber-600" />
            </div>
            <h3 className="mt-4 text-xl font-semibold text-slate-800">No saved funnels</h3>
            <p className="mt-2 text-slate-600">
              Use the <strong>Affiliate Browser Chat</strong> to analyze funnels with
              the AI agent and save them here.
            </p>
            <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={openCreateModal}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 font-medium text-white shadow-md hover:bg-emerald-400 transition-colors"
              >
                <PlusCircle className="h-5 w-5" />
                  Create Funnel from Scratch
                </button>
              <a
                href="/affiliate-browser-chat"
                className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-2.5 font-medium text-white shadow-md hover:bg-amber-600 transition-colors"
              >
                Go to Affiliate Browser Chat
              </a>
            </div>
          </div>
        )}

        {/* ══ No results for filters ══ */}
        {!loading && !error && funnels.length > 0 && filtered.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <Search className="mx-auto h-10 w-10 text-slate-300" />
            <h3 className="mt-3 text-lg font-semibold text-slate-700">No results</h3>
            <p className="mt-1 text-sm text-slate-500">
              {activeTab === 'quiz'
                ? 'No quiz funnel found. Try adjusting the filters.'
                : 'Try adjusting the search filters.'}
            </p>
          </div>
        )}

        {/* ══ Funnel cards grid ══ */}
        {!loading && !error && filtered.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((funnel) => {
              const isExpanded = expandedIds.has(funnel.id);
              const isDeleting = deletingId === funnel.id;
              const steps = parseSteps(funnel.steps);
              const typeColor = FUNNEL_TYPE_COLORS[funnel.funnel_type] ?? FUNNEL_TYPE_COLORS.other;
              const isFunnelSel = isFunnelFullySelected(funnel.id);
              const hasPageSel = selectedPages.has(funnel.id);
              const pageSelCount = selectedPages.get(funnel.id)?.size ?? 0;

              return (
                <div
                  key={funnel.id}
                  className={`overflow-hidden rounded-2xl border-2 bg-white shadow-md transition-all ${
                    isFunnelSel
                      ? 'border-amber-400 ring-2 ring-amber-200 shadow-amber-100'
                      : hasPageSel
                        ? 'border-amber-300/60 shadow-amber-50'
                        : 'border-slate-200/80 hover:border-amber-200 hover:shadow-lg'
                  }`}
                >
                  {/* Card header */}
                  <div className="p-5">
                    <div className="flex items-start gap-3">
                      {/* Selection checkbox — full funnel */}
                      <button
                        type="button"
                        onClick={() => toggleSelectFunnel(funnel)}
                        className={`mt-1 shrink-0 rounded-lg p-1 transition-colors ${
                          isFunnelSel
                            ? 'text-amber-600 hover:text-amber-700'
                            : 'text-slate-300 hover:text-amber-500'
                        }`}
                        title={isFunnelSel ? 'Deselect entire funnel' : 'Select entire funnel'}
                      >
                        {isFunnelSel ? (
                          <CheckSquare className="h-5 w-5" />
                        ) : (
                          <Square className="h-5 w-5" />
                        )}
                      </button>

                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100">
                        <Globe className="h-6 w-6 text-slate-500" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <h3 className="font-bold text-slate-800 truncate">{funnel.funnel_name}</h3>
                        {funnel.brand_name && (
                          <p className="text-xs text-slate-500 mt-0.5 truncate">{funnel.brand_name}</p>
                        )}

                        {/* Badges: type + category + selection */}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeColor}`}
                          >
                            {FUNNEL_TYPE_LABELS[funnel.funnel_type] ?? funnel.funnel_type}
                          </span>
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {CATEGORY_LABELS[funnel.category] ?? funnel.category}
                          </span>
                          {(isFunnelSel || hasPageSel) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                              <CheckCircle2 className="h-3 w-3" />
                              {isFunnelSel ? 'Entire funnel' : `${pageSelCount} page${pageSelCount === 1 ? '' : 's'}`}
                            </span>
                          )}
                        </div>

                        {/* Tags */}
                        {funnel.tags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {funnel.tags.slice(0, 4).map((tag, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-0.5 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 border border-amber-200/60"
                              >
                                <Tag className="h-2.5 w-2.5" />
                                {tag}
                              </span>
                            ))}
                            {funnel.tags.length > 4 && (
                              <span className="text-[10px] text-slate-400">+{funnel.tags.length - 4}</span>
                            )}
                          </div>
                        )}

                        {/* Meta row */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <FileStack className="h-3.5 w-3.5" />
                            {funnel.total_steps} step
                          </span>
                          {funnel.lead_capture_method && funnel.lead_capture_method !== 'none' && (
                            <span className="inline-flex items-center gap-1">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              {funnel.lead_capture_method}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            {formatDate(funnel.created_at)}
                          </span>
                        </div>

                        {/* Entry URL */}
                        <a
                          href={funnel.entry_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1.5 block truncate text-xs text-amber-600 hover:underline"
                        >
                          {funnel.entry_url}
                        </a>
                      </div>
                    </div>

                    {/* Analysis summary */}
                    {funnel.analysis_summary && (
                      <p className="mt-3 text-xs text-slate-600 leading-relaxed line-clamp-3 bg-slate-50 rounded-lg p-2.5 border border-slate-100">
                        <Sparkles className="h-3 w-3 inline mr-1 text-amber-500" />
                        {funnel.analysis_summary}
                      </p>
                    )}

                    {/* Persuasion techniques */}
                    {funnel.persuasion_techniques.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1">
                        {funnel.persuasion_techniques.slice(0, 3).map((tech, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-0.5 rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700 border border-violet-200/60"
                          >
                            <Lightbulb className="h-2.5 w-2.5" />
                            {tech}
                          </span>
                        ))}
                        {funnel.persuasion_techniques.length > 3 && (
                          <span className="text-[10px] text-slate-400">
                            +{funnel.persuasion_techniques.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(funnel.id)}
                        className="flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-amber-600"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        {isExpanded ? 'Hide steps' : `View ${steps.length} steps`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDetailFunnel(funnel)}
                        className="flex items-center gap-1 text-sm font-medium text-amber-600 hover:text-amber-700"
                      >
                        <Eye className="h-4 w-4" />
                        Details
                      </button>
                      <a
                        href={`/front-end-funnel?import_funnel_id=${funnel.id}`}
                        className="flex items-center gap-1 text-sm font-medium text-emerald-600 hover:text-emerald-700"
                        title="Import to Front End Funnel to clone"
                      >
                        <Repeat className="h-4 w-4" />
                        Swipe
                      </a>
                      <button
                        type="button"
                        onClick={() => setFlowFunnel(funnel)}
                        className="flex items-center gap-1 text-sm font-medium text-violet-600 hover:text-violet-700"
                      >
                        <Workflow className="h-4 w-4" />
                        Funnel View
                      </button>
                      <button
                        type="button"
                        onClick={() => handleImportToArchive(funnel)}
                        disabled={archivingId === funnel.id}
                        className="flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                        title="Import to My Archive"
                      >
                        {archivingId === funnel.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                        Archive
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(funnel)}
                      disabled={isDeleting}
                      className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                      title="Delete funnel"
                    >
                      {isDeleting ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <Trash2 className="h-5 w-5" />
                      )}
                    </button>
                  </div>

                  {/* ── Expanded steps — with per-step selection ── */}
                  {isExpanded && steps.length > 0 && (
                    <div className="border-t border-slate-100 bg-slate-50/50">
                      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                          Select individual pages
                        </span>
                        {!isFunnelSel && pageSelCount > 0 && pageSelCount < steps.length && (
                          <span className="text-[10px] text-amber-600 font-medium">
                            {pageSelCount}/{steps.length} selected
                          </span>
                        )}
                      </div>

                      <ul className="divide-y divide-slate-100 p-3 pt-1">
                        {steps.map((step, idx) => {
                          const stepTypeColor =
                            STEP_TYPE_COLORS[step.step_type ?? 'other'] ?? STEP_TYPE_COLORS.other;
                          const stepIdx = step.step_index ?? idx + 1;
                          const stepSel = isStepSelected(funnel.id, stepIdx);

                          return (
                            <li
                              key={idx}
                              className={`flex items-start gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
                                stepSel
                                  ? 'bg-amber-50/80 ring-1 ring-amber-200'
                                  : 'hover:bg-white/80'
                              }`}
                              onClick={() => toggleSelectStep(funnel.id, stepIdx)}
                            >
                              {/* Step checkbox */}
                              <div
                                className={`mt-0.5 shrink-0 ${
                                  stepSel ? 'text-amber-600' : 'text-slate-300'
                                }`}
                              >
                                {stepSel ? (
                                  <CheckCircle2 className="h-5 w-5" />
                                ) : (
                                  <Circle className="h-5 w-5" />
                                )}
                              </div>

                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-700 mt-0.5">
                                {stepIdx}
                              </span>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-medium text-slate-800 text-sm truncate">
                                    {step.title || 'Untitled'}
                                  </p>
                                  {step.step_type && (
                                    <span
                                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${stepTypeColor}`}
                                    >
                                      {step.step_type.replace(/_/g, ' ')}
                                    </span>
                                  )}
                                </div>
                                {step.description && (
                                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                                    {step.description}
                                  </p>
                                )}
                                {step.cta_text && (
                                  <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 border border-emerald-200/60">
                                    <Zap className="h-2.5 w-2.5" />
                                    CTA: {step.cta_text}
                                  </span>
                                )}
                                {step.options && step.options.length > 0 && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {step.options.map((opt, oi) => (
                                      <span
                                        key={oi}
                                        className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
                                      >
                                        {opt}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {step.url && (
                                  <a
                                    href={step.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-1 block truncate text-[11px] text-amber-600 hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {step.url}
                                  </a>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ══════ Floating Selection Bar ══════ */}
      {hasSelection && (
        <div className="fixed bottom-0 inset-x-0 z-40">
          <div className="mx-auto max-w-5xl px-6 pb-6">
            <div className="rounded-2xl bg-slate-900 shadow-2xl border border-slate-700 px-6 py-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20">
                    <ClipboardList className="h-5 w-5 text-amber-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {totalSelectedFunnels > 0 && (
                        <span>
                          {totalSelectedFunnels} complete funnel{totalSelectedFunnels === 1 ? '' : 's'}
                        </span>
                      )}
                      {totalSelectedFunnels > 0 && totalSelectedPages > 0 && (
                        <span className="text-slate-400"> + </span>
                      )}
                      {totalSelectedPages > 0 && (
                        <span>
                          {totalSelectedPages} individual page{totalSelectedPages === 1 ? '' : 's'}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      {selectedItems.length <= 4
                        ? selectedItems
                            .map((item) =>
                              item.type === 'full_funnel'
                                ? item.funnelName
                                : `${item.stepTitle} (${item.funnelName})`,
                            )
                            .join(', ')
                        :                         `${selectedItems
                            .slice(0, 3)
                            .map((item) =>
                              item.type === 'full_funnel' ? item.funnelName : item.stepTitle,
                            )
                            .join(', ')} and ${selectedItems.length - 3} more...`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="rounded-xl px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    Deselect all
                  </button>
                  <button
                    type="button"
                    className="rounded-xl bg-amber-500 px-5 py-2 text-sm font-bold text-white shadow-md hover:bg-amber-400 transition-colors flex items-center gap-2"
                    onClick={openSaveModal}
                  >
                    <Save className="h-4 w-4" />
                    Save as new funnel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════ Save as New Funnel Modal ══════ */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-amber-50 to-orange-50 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20">
                  <Plus className="h-5 w-5 text-amber-700" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-800">Save as new funnel</h3>
                  <p className="text-xs text-slate-500">
                    {collectedSteps.length} step{collectedSteps.length === 1 ? '' : 's'} selected
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {saveSuccess ? (
                <div className="flex flex-col items-center py-6">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                  </div>
                  <p className="mt-3 text-lg font-bold text-slate-800">Funnel saved!</p>
                  <p className="mt-1 text-sm text-slate-500">&ldquo;{saveSuccess}&rdquo; created successfully</p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Funnel name <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={saveForm.funnel_name}
                      onChange={(e) => setSaveForm((p) => ({ ...p, funnel_name: e.target.value }))}
                      placeholder="E.g. My custom quiz funnel"
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
                      autoFocus
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Funnel type</label>
                      <select
                        value={saveForm.funnel_type}
                        onChange={(e) => setSaveForm((p) => ({ ...p, funnel_type: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
                      >
                        {Object.entries(FUNNEL_TYPE_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Category</label>
                      <select
                        value={saveForm.category}
                        onChange={(e) => setSaveForm((p) => ({ ...p, category: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
                      >
                        {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Brand (optional)</label>
                    <input
                      type="text"
                      value={saveForm.brand_name}
                      onChange={(e) => setSaveForm((p) => ({ ...p, brand_name: e.target.value }))}
                      placeholder="E.g. BrandName"
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-200 outline-none"
                    />
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                      <FileStack className="h-3.5 w-3.5 text-amber-500" />
                      Step preview ({collectedSteps.length})
                    </p>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {collectedSteps.map((step) => {
                        const stepColor = STEP_TYPE_COLORS[step.step_type ?? 'other'] ?? STEP_TYPE_COLORS.other;
                        return (
                          <div key={step.step_index} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-100">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-700">
                              {step.step_index}
                            </span>
                            <span className="text-xs text-slate-700 truncate flex-1">{step.title || 'Untitled'}</span>
                            {step.step_type && (
                              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${stepColor}`}>
                                {step.step_type.replace(/_/g, ' ')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowSaveModal(false)}
                      className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveAsNewFunnel}
                      disabled={saving || !saveForm.funnel_name.trim()}
                      className="rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-bold text-white shadow-md hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {saving ? 'Saving...' : 'Save funnel'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════ Create From Scratch Modal ══════ */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-3xl max-h-[92vh] overflow-hidden rounded-2xl bg-white shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-emerald-50 to-teal-50 px-6 py-4 shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/20">
                  <PlusCircle className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-800">Create Funnel Template from Scratch</h3>
                  <p className="text-xs text-slate-500">Manually enter all the funnel information</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {createSuccess ? (
                <div className="flex flex-col items-center py-10">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                  </div>
                  <p className="mt-3 text-lg font-bold text-slate-800">Funnel created!</p>
                  <p className="mt-1 text-sm text-slate-500">&ldquo;{createSuccess}&rdquo; saved successfully</p>
                </div>
              ) : (
                <>
                  {/* ── Section: Info base ── */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
                    <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                      <Edit3 className="h-4 w-4 text-emerald-500" />
                      Basic information
                    </h4>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Funnel name <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={createForm.funnel_name}
                        onChange={(e) => setCreateForm((p) => ({ ...p, funnel_name: e.target.value }))}
                        placeholder="E.g. Keto Weight Loss Quiz"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                        autoFocus
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Funnel type</label>
                        <select
                          value={createForm.funnel_type}
                          onChange={(e) => setCreateForm((p) => ({ ...p, funnel_type: e.target.value }))}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                        >
                          {Object.entries(FUNNEL_TYPE_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Category</label>
                        <select
                          value={createForm.category}
                          onChange={(e) => setCreateForm((p) => ({ ...p, category: e.target.value }))}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                        >
                          {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Brand (optional)</label>
                        <input
                          type="text"
                          value={createForm.brand_name}
                          onChange={(e) => setCreateForm((p) => ({ ...p, brand_name: e.target.value }))}
                          placeholder="Es. KetoSlim"
                          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Lead Capture Method</label>
                        <select
                          value={createForm.lead_capture_method}
                          onChange={(e) => setCreateForm((p) => ({ ...p, lead_capture_method: e.target.value }))}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                        >
                          <option value="none">None</option>
                          <option value="email">Email</option>
                          <option value="phone">Phone</option>
                          <option value="email_phone">Email + Phone</option>
                          <option value="form">Form completo</option>
                          <option value="quiz">Quiz</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Entry URL (optional)</label>
                      <input
                        type="url"
                        value={createForm.entry_url}
                        onChange={(e) => setCreateForm((p) => ({ ...p, entry_url: e.target.value }))}
                        placeholder="https://example.com/funnel"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Description / Summary (optional)</label>
                      <textarea
                        value={createForm.analysis_summary}
                        onChange={(e) => setCreateForm((p) => ({ ...p, analysis_summary: e.target.value }))}
                        placeholder="Describe the structure and purpose of this funnel..."
                        rows={2}
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none resize-none"
                      />
                    </div>
                  </div>

                  {/* ── Section: Tags & Techniques ── */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
                    <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                      <Tag className="h-4 w-4 text-amber-500" />
                      Tags, Techniques &amp; Elements
                    </h4>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Tags <span className="text-xs text-slate-400">(comma-separated)</span>
                      </label>
                      <input
                        type="text"
                        value={createForm.tags}
                        onChange={(e) => setCreateForm((p) => ({ ...p, tags: e.target.value }))}
                        placeholder="Es. quiz, weight loss, keto, supplement"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Persuasion techniques <span className="text-xs text-slate-400">(comma-separated)</span>
                      </label>
                      <input
                        type="text"
                        value={createForm.persuasion_techniques}
                        onChange={(e) => setCreateForm((p) => ({ ...p, persuasion_techniques: e.target.value }))}
                        placeholder="Es. scarcity, social proof, authority, urgency"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Notable elements <span className="text-xs text-slate-400">(comma-separated)</span>
                      </label>
                      <input
                        type="text"
                        value={createForm.notable_elements}
                        onChange={(e) => setCreateForm((p) => ({ ...p, notable_elements: e.target.value }))}
                        placeholder="Es. video testimonial, countdown timer, money-back guarantee"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 outline-none"
                      />
                    </div>
                  </div>

                  {/* ── Section: Steps ── */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                        <FileStack className="h-4 w-4 text-violet-500" />
                        Funnel Steps ({scratchSteps.length})
                      </h4>
                      <button
                        type="button"
                        onClick={addScratchStep}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-400 transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add Step
                      </button>
                    </div>

                    <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                      {scratchSteps.map((step, idx) => (
                        <div
                          key={step.id}
                          className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm"
                        >
                          {/* Step header */}
                          <div className="flex items-center gap-2">
                            <GripVertical className="h-4 w-4 text-slate-300 shrink-0" />
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                              {idx + 1}
                            </span>
                            <input
                              type="text"
                              value={step.title}
                              onChange={(e) => updateScratchStep(step.id, 'title', e.target.value)}
                              placeholder={`Step ${idx + 1} Title`}
                              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none"
                            />
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => moveScratchStep(step.id, 'up')}
                                disabled={idx === 0}
                                className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Move up"
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveScratchStep(step.id, 'down')}
                                disabled={idx === scratchSteps.length - 1}
                                className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Move down"
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => duplicateScratchStep(step.id)}
                                className="rounded p-1 text-slate-400 hover:text-violet-600 hover:bg-violet-50"
                                title="Duplicate step"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeScratchStep(step.id)}
                                disabled={scratchSteps.length <= 1}
                                className="rounded p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Remove step"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Step fields */}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">Step Type</label>
                              <select
                                value={step.step_type}
                                onChange={(e) => updateScratchStep(step.id, 'step_type', e.target.value)}
                                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none"
                              >
                                {Object.entries(STEP_TYPE_LABELS).map(([val, label]) => (
                                  <option key={val} value={val}>{label}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">Input Type</label>
                              <select
                                value={step.input_type}
                                onChange={(e) => updateScratchStep(step.id, 'input_type', e.target.value)}
                                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none"
                              >
                                <option value="none">None</option>
                                <option value="single_choice">Single Choice</option>
                                <option value="multiple_choice">Multiple Choice</option>
                                <option value="text_input">Text Input</option>
                                <option value="email_input">Email Input</option>
                                <option value="slider">Slider</option>
                                <option value="image_choice">Image Choice</option>
                              </select>
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Page URL (optional)</label>
                            <input
                              type="url"
                              value={step.url}
                              onChange={(e) => updateScratchStep(step.id, 'url', e.target.value)}
                              placeholder="https://..."
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder-slate-400 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Description (optional)</label>
                            <textarea
                              value={step.description}
                              onChange={(e) => updateScratchStep(step.id, 'description', e.target.value)}
                              placeholder="What this step does..."
                              rows={2}
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder-slate-400 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none resize-none"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">CTA Text (optional)</label>
                            <input
                              type="text"
                              value={step.cta_text}
                              onChange={(e) => updateScratchStep(step.id, 'cta_text', e.target.value)}
                              placeholder="E.g. Continue, Discover now, Order now"
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder-slate-400 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-200 outline-none"
                            />
                          </div>

                          {/* Options */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">
                              Options/Answers <span className="text-slate-400">(for quiz/choice)</span>
                            </label>
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {step.options.map((opt, oi) => (
                                <span
                                  key={oi}
                                  className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-2 py-0.5 text-xs text-violet-700 border border-violet-200/60"
                                >
                                  {opt}
                                  <button
                                    type="button"
                                    onClick={() => removeOptionFromStep(step.id, oi)}
                                    className="text-violet-400 hover:text-red-500"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </span>
                              ))}
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="Add option..."
                                value={editingStepOptionIdx?.stepId === step.id ? editingStepOptionIdx.text : ''}
                                onChange={(e) => setEditingStepOptionIdx({ stepId: step.id, text: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && editingStepOptionIdx?.stepId === step.id) {
                                    e.preventDefault();
                                    addOptionToStep(step.id, editingStepOptionIdx.text);
                                    setEditingStepOptionIdx(null);
                                  }
                                }}
                                className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder-slate-400 focus:border-violet-400 focus:ring-1 focus:ring-violet-200 outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (editingStepOptionIdx?.stepId === step.id) {
                                    addOptionToStep(step.id, editingStepOptionIdx.text);
                                    setEditingStepOptionIdx(null);
                                  }
                                }}
                                className="rounded-lg bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200 transition-colors"
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={addScratchStep}
                      className="w-full rounded-xl border-2 border-dashed border-slate-300 py-3 text-sm font-medium text-slate-500 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50/50 transition-colors flex items-center justify-center gap-2"
                    >
                      <Plus className="h-4 w-4" />
                      Add another step
                    </button>
                  </div>

                  {/* ── Footer buttons ── */}
                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowCreateModal(false)}
                      className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateFromScratch}
                      disabled={createSaving || !createForm.funnel_name.trim()}
                      className="rounded-xl bg-emerald-500 px-6 py-2.5 text-sm font-bold text-white shadow-md hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {createSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {createSaving ? 'Creating...' : 'Create Funnel'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════ Flow View Modal ══════ */}
      {flowFunnel && (
        <FunnelFlowView funnel={flowFunnel} onClose={() => setFlowFunnel(null)} />
      )}

      {/* ══════ Detail Modal ══════ */}
      {detailFunnel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-amber-50 to-orange-50 px-6 py-4">
              <div className="flex items-center gap-3 min-w-0">
                <LayoutList className="h-6 w-6 text-amber-500 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-bold text-slate-800 truncate">{detailFunnel.funnel_name}</h3>
                  <p className="text-xs text-slate-500">
                    {FUNNEL_TYPE_LABELS[detailFunnel.funnel_type] ?? detailFunnel.funnel_type}{' '}
                    &middot; {CATEGORY_LABELS[detailFunnel.category] ?? detailFunnel.category}{' '}
                    &middot; {detailFunnel.total_steps} step
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailFunnel(null)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Summary */}
              {detailFunnel.analysis_summary && (
                <div className="rounded-xl border border-amber-200/60 bg-amber-50/50 p-4">
                  <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                    <Sparkles className="h-4 w-4 text-amber-500" />
                    AI Analysis
                  </h4>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {detailFunnel.analysis_summary}
                  </p>
                </div>
              )}

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-3">
                {detailFunnel.brand_name && (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                      Brand
                    </p>
                    <p className="text-sm font-medium text-slate-800">{detailFunnel.brand_name}</p>
                  </div>
                )}
                {detailFunnel.lead_capture_method &&
                  detailFunnel.lead_capture_method !== 'none' && (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                        Lead Capture
                      </p>
                      <p className="text-sm font-medium text-slate-800">
                        {detailFunnel.lead_capture_method}
                      </p>
                    </div>
                  )}
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                    Entry URL
                  </p>
                  <a
                    href={detailFunnel.entry_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-amber-600 hover:underline truncate block"
                  >
                    {detailFunnel.entry_url}
                  </a>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                    Saved on
                  </p>
                  <p className="text-sm font-medium text-slate-800">
                    {formatDate(detailFunnel.created_at)}
                  </p>
                </div>
              </div>

              {/* Tags */}
              {detailFunnel.tags.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1">
                    <Tag className="h-3.5 w-3.5" />
                    Tags
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {detailFunnel.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-700 border border-amber-200/60"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Persuasion techniques */}
              {detailFunnel.persuasion_techniques.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1">
                    <Lightbulb className="h-3.5 w-3.5" />
                    Persuasion techniques
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {detailFunnel.persuasion_techniques.map((tech, i) => (
                      <span
                        key={i}
                        className="rounded-md bg-violet-50 px-2 py-0.5 text-xs text-violet-700 border border-violet-200/60"
                      >
                        {tech}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Notable elements */}
              {detailFunnel.notable_elements.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1">
                    <Eye className="h-3.5 w-3.5" />
                    Notable elements
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {detailFunnel.notable_elements.map((el, i) => (
                      <span
                        key={i}
                        className="rounded-md bg-teal-50 px-2 py-0.5 text-xs text-teal-700 border border-teal-200/60"
                      >
                        {el}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Steps */}
              {(() => {
                const steps = parseSteps(detailFunnel.steps);
                if (steps.length === 0) return null;
                return (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1">
                      <FileStack className="h-3.5 w-3.5" />
                      Funnel steps ({steps.length})
                    </h4>
                    <div className="space-y-2">
                      {steps.map((step, idx) => {
                        const stepTypeColor =
                          STEP_TYPE_COLORS[step.step_type ?? 'other'] ?? STEP_TYPE_COLORS.other;
                        const stepIdx = step.step_index ?? idx + 1;
                        const stepSel = isStepSelected(detailFunnel.id, stepIdx);

                        return (
                          <div
                            key={idx}
                            className={`rounded-xl border p-3 cursor-pointer transition-colors ${
                              stepSel
                                ? 'border-amber-300 bg-amber-50/50 ring-1 ring-amber-200'
                                : 'border-slate-200 bg-white hover:border-amber-200'
                            }`}
                            onClick={() => toggleSelectStep(detailFunnel.id, stepIdx)}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <div
                                className={`shrink-0 ${
                                  stepSel ? 'text-amber-600' : 'text-slate-300'
                                }`}
                              >
                                {stepSel ? (
                                  <CheckCircle2 className="h-4 w-4" />
                                ) : (
                                  <Circle className="h-4 w-4" />
                                )}
                              </div>
                              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700">
                                {stepIdx}
                              </span>
                              <span className="font-medium text-sm text-slate-800">
                                {step.title || 'Untitled'}
                              </span>
                              {step.step_type && (
                                <span
                                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${stepTypeColor}`}
                                >
                                  {step.step_type.replace(/_/g, ' ')}
                                </span>
                              )}
                              {step.input_type && step.input_type !== 'none' && (
                                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                  {step.input_type.replace(/_/g, ' ')}
                                </span>
                              )}
                            </div>
                            {step.description && (
                              <p className="mt-1 text-xs text-slate-600 ml-6">{step.description}</p>
                            )}
                            {step.cta_text && (
                              <span className="mt-1.5 ml-6 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 border border-emerald-200/60">
                                <Zap className="h-3 w-3" />
                                {step.cta_text}
                              </span>
                            )}
                            {step.options && step.options.length > 0 && (
                              <div className="mt-1.5 ml-6 flex flex-wrap gap-1">
                                {step.options.map((opt, oi) => (
                                  <span
                                    key={oi}
                                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
                                  >
                                    {opt}
                                  </span>
                                ))}
                              </div>
                            )}
                            {step.url && (
                              <a
                                href={step.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1 ml-6 inline-flex items-center gap-1 text-[11px] text-amber-600 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="h-3 w-3" />
                                {step.url}
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
