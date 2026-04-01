'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { BUILT_IN_PAGE_TYPE_OPTIONS, PAGE_TYPE_CATEGORIES, PageType, PageTypeOption, TemplateCategory, TEMPLATE_CATEGORY_OPTIONS, TemplateViewFormat, TEMPLATE_VIEW_FORMAT_OPTIONS, LIBRARY_TEMPLATES } from '@/types';
import type { ArchivedFunnel } from '@/types/database';
import { Plus, Trash2, Edit2, Save, X, FileCode, ExternalLink, Tag, Filter, Eye, EyeOff, Maximize2, Layers, HelpCircle, FolderPlus, Settings, Monitor, Smartphone, BookOpen, ChevronDown, ChevronRight, FolderOpen, Archive, CheckSquare, Square, Package, Sparkles, Send, Loader2, MessageCircle, Search } from 'lucide-react';
import CachedScreenshot from '@/components/CachedScreenshot';

interface SelectedPage {
  name: string;
  page_type: string;
  url_to_swipe: string;
  prompt: string;
  funnel_name: string;
}

interface StagedImport extends SelectedPage {
  productId: string;
  productName: string;
}

interface NewTemplateForm {
  name: string;
  sourceUrl: string;
  pageType: PageType;
  category: TemplateCategory;
  viewFormat: TemplateViewFormat;
  tags: string[];
  description: string;
}

const emptyForm: NewTemplateForm = {
  name: '',
  sourceUrl: '',
  pageType: 'landing',
  category: 'standard',
  viewFormat: 'desktop',
  tags: [],
  description: '',
};

export default function TemplatesPage() {
  const { templates, addTemplate, updateTemplate, deleteTemplate, customPageTypes, addCustomPageType, deleteCustomPageType, archivedFunnels, archivedFunnelsLoaded, loadArchivedFunnels, deleteArchivedFunnel, products, addFunnelPage, funnelPages, deleteFunnelPage } = useStore();
  const router = useRouter();
  
  const [mainView, setMainView] = useState<'templates' | 'funnels' | 'byType' | 'quiz'>('templates');
  const [expandedFunnelIds, setExpandedFunnelIds] = useState<string[]>([]);
  const [expandedTypes, setExpandedTypes] = useState<string[]>([]);

  // Selection state
  const [selectedPages, setSelectedPages] = useState<SelectedPage[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);

  // Staged imports for "By Type" (accumulate before final import)
  const [stagedImports, setStagedImports] = useState<StagedImport[]>([]);

  const togglePage = useCallback((page: SelectedPage) => {
    setSelectedPages(prev => {
      const key = `${page.funnel_name}::${page.name}::${page.url_to_swipe}`;
      const exists = prev.some(p => `${p.funnel_name}::${p.name}::${p.url_to_swipe}` === key);
      return exists ? prev.filter(p => `${p.funnel_name}::${p.name}::${p.url_to_swipe}` !== key) : [...prev, page];
    });
  }, []);

  const isPageSelected = useCallback((page: { funnel_name: string; name: string; url_to_swipe: string }) => {
    const key = `${page.funnel_name}::${page.name}::${page.url_to_swipe}`;
    return selectedPages.some(p => `${p.funnel_name}::${p.name}::${p.url_to_swipe}` === key);
  }, [selectedPages]);

  const toggleFunnel = useCallback((funnel: ArchivedFunnel) => {
    const steps = (funnel.steps as { step_index: number; name: string; page_type: string; url_to_swipe: string; prompt: string }[]) || [];
    const funnelPages_ = steps.map(s => ({ name: s.name, page_type: s.page_type, url_to_swipe: s.url_to_swipe, prompt: s.prompt || '', funnel_name: funnel.name }));
    const allSelected = funnelPages_.every(p => isPageSelected(p));
    if (allSelected) {
      setSelectedPages(prev => prev.filter(p => !funnelPages_.some(fp => `${fp.funnel_name}::${fp.name}::${fp.url_to_swipe}` === `${p.funnel_name}::${p.name}::${p.url_to_swipe}`)));
    } else {
      setSelectedPages(prev => {
        const newPages = funnelPages_.filter(fp => !prev.some(p => `${p.funnel_name}::${p.name}::${p.url_to_swipe}` === `${fp.funnel_name}::${fp.name}::${fp.url_to_swipe}`));
        return [...prev, ...newPages];
      });
    }
  }, [isPageSelected]);

  const isFunnelFullySelected = useCallback((funnel: ArchivedFunnel) => {
    const steps = (funnel.steps as { name: string; page_type: string; url_to_swipe: string }[]) || [];
    return steps.length > 0 && steps.every(s => isPageSelected({ funnel_name: funnel.name, name: s.name, url_to_swipe: s.url_to_swipe }));
  }, [isPageSelected]);

  const handleImportToFunnel = async () => {
    if (!selectedProductId || selectedPages.length === 0) return;
    setIsImporting(true);
    try {
      for (const page of selectedPages) {
        await addFunnelPage({
          name: page.name,
          pageType: (page.page_type || 'landing') as PageType,
          productId: selectedProductId,
          urlToSwipe: page.url_to_swipe,
          prompt: page.prompt || undefined,
          swipeStatus: 'pending',
          templateId: undefined,
          swipeResult: undefined,
          feedback: undefined,
          clonedData: undefined,
          swipedData: undefined,
          analysisStatus: undefined,
          analysisResult: undefined,
          extractedData: undefined,
        });
      }
      setSelectedPages([]);
      router.push('/front-end-funnel');
    } catch (error) {
      console.error('Error importing pages:', error);
      alert('Import error');
    } finally {
      setIsImporting(false);
    }
  };

  const handleStagePages = () => {
    if (!selectedProductId || selectedPages.length === 0) return;
    const product = (products || []).find(p => p.id === selectedProductId);
    const newStaged: StagedImport[] = selectedPages.map(page => ({
      ...page,
      productId: selectedProductId,
      productName: product?.name || '',
    }));
    setStagedImports(prev => {
      const filtered = prev.filter(s =>
        !newStaged.some(n => `${n.funnel_name}::${n.name}::${n.url_to_swipe}` === `${s.funnel_name}::${s.name}::${s.url_to_swipe}`)
      );
      return [...filtered, ...newStaged];
    });
    setSelectedPages([]);
    setSelectedProductId('');
  };

  const handleImportStaged = async () => {
    if (stagedImports.length === 0) return;
    setIsImporting(true);
    try {
      for (const page of stagedImports) {
        await addFunnelPage({
          name: page.name,
          pageType: (page.page_type || 'landing') as PageType,
          productId: page.productId,
          urlToSwipe: page.url_to_swipe,
          prompt: page.prompt || undefined,
          swipeStatus: 'pending',
          templateId: undefined,
          swipeResult: undefined,
          feedback: undefined,
          clonedData: undefined,
          swipedData: undefined,
          analysisStatus: undefined,
          analysisResult: undefined,
          extractedData: undefined,
        });
      }
      setStagedImports([]);
      setSelectedPages([]);
      router.push('/front-end-funnel');
    } catch (error) {
      console.error('Error importing staged pages:', error);
      alert('Import error');
    } finally {
      setIsImporting(false);
    }
  };

  const removeStagedImport = (index: number) => {
    setStagedImports(prev => prev.filter((_, i) => i !== index));
  };

  useEffect(() => {
    if (mainView !== 'templates' && !archivedFunnelsLoaded) {
      loadArchivedFunnels();
    }
  }, [mainView, archivedFunnelsLoaded, loadArchivedFunnels]);

  const pagesByType = useMemo(() => {
    const map: Record<string, { funnel_name: string; funnel_id: string; name: string; url_to_swipe: string; prompt: string; template_name: string; product_name: string; swipe_status: string }[]> = {};
    (archivedFunnels || []).forEach((f: ArchivedFunnel) => {
      const steps = (f.steps as { step_index: number; name: string; page_type: string; url_to_swipe: string; prompt: string; template_name: string; product_name: string; swipe_status: string }[]) || [];
      steps.forEach((s) => {
        const t = s.page_type || 'other';
        if (!map[t]) map[t] = [];
        map[t].push({ funnel_name: f.name, funnel_id: f.id, name: s.name, url_to_swipe: s.url_to_swipe, prompt: s.prompt || '', template_name: s.template_name || '', product_name: s.product_name || '', swipe_status: s.swipe_status || '' });
      });
    });
    return map;
  }, [archivedFunnels]);

  const getPageTypeLabel = (value: string): string => {
    const opt = BUILT_IN_PAGE_TYPE_OPTIONS.find(o => o.value === value);
    return opt?.label || value;
  };

  // AI Analysis state (funnels)
  const [analyzingFunnelIds, setAnalyzingFunnelIds] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<Record<string, { role: string; content: string }[]>>({});
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [activeChatFunnelId, setActiveChatFunnelId] = useState<string | null>(null);
  const autoAnalyzedRef = useRef<Set<string>>(new Set());

  // AI Analysis state (by type) — persisted in localStorage
  const [typeAnalysis, setTypeAnalysis] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const stored = localStorage.getItem('type_analyses');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  const [analyzingTypeIds, setAnalyzingTypeIds] = useState<Set<string>>(new Set());
  const [typeChatMessages, setTypeChatMessages] = useState<Record<string, { role: string; content: string }[]>>({});
  const [typeChatInput, setTypeChatInput] = useState('');
  const [isTypeChatLoading, setIsTypeChatLoading] = useState(false);
  const [activeTypeChatId, setActiveTypeChatId] = useState<string | null>(null);
  const autoAnalyzedTypesRef = useRef<Set<string>>(new Set());

  const runAnalysis = useCallback(async (funnel: ArchivedFunnel) => {
    if (analyzingFunnelIds.has(funnel.id)) return;
    setAnalyzingFunnelIds(prev => new Set(prev).add(funnel.id));
    try {
      const res = await fetch('/api/funnel-brief/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnel_name: funnel.name, steps: funnel.steps }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Save to DB
      await fetch('/api/funnel-brief/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnel_id: funnel.id, analysis: data.analysis }),
      });
      // Update local store
      useStore.setState((state) => ({
        archivedFunnels: state.archivedFunnels.map(f =>
          f.id === funnel.id ? { ...f, analysis: data.analysis } : f
        ),
      }));
    } catch (error) {
      console.error('Analysis failed:', error);
    } finally {
      setAnalyzingFunnelIds(prev => { const n = new Set(prev); n.delete(funnel.id); return n; });
    }
  }, [analyzingFunnelIds]);

  // Auto-trigger analysis ONLY ONCE for funnels that don't have one yet
  useEffect(() => {
    expandedFunnelIds.forEach(fid => {
      if (autoAnalyzedRef.current.has(fid)) return;
      const funnel = archivedFunnels.find(f => f.id === fid);
      if (funnel && !funnel.analysis) {
        autoAnalyzedRef.current.add(fid);
        runAnalysis(funnel);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedFunnelIds]);

  const buildFullContext = useCallback((funnelId: string) => {
    const funnel = archivedFunnels.find(f => f.id === funnelId);
    const brief = funnel?.analysis || '';
    const stepsText = ((funnel?.steps as { step_index: number; name: string; page_type: string; url_to_swipe: string; product_name: string }[]) || [])
      .map(s => `Step ${s.step_index}: "${s.name}" (${s.page_type}) — URL: ${s.url_to_swipe || 'N/A'} — Product: ${s.product_name || 'N/A'}`).join('\n');

    const productsText = (products || []).map(p => `- ${p.name}: ${p.description} (€${p.price})`).join('\n');
    const templatesText = (templates || []).slice(0, 20).map(t => `- ${t.name} (${t.pageType})`).join('\n');
    const allFunnelsText = archivedFunnels.map(f => `- "${f.name}" (${f.total_steps} step)`).join('\n');
    const funnelPagesText = (funnelPages || []).map((p, i) => `Step ${i + 1}: "${p.name}" (${p.pageType})`).join('\n');

    return [
      `=== FUNNEL UNDER ANALYSIS ===`,
      `Name: ${funnel?.name}`,
      `Steps:\n${stepsText}`,
      brief ? `\n=== AI BRIEF ===\n${brief}` : '',
      `\n=== AVAILABLE PRODUCTS ===\n${productsText || 'No products'}`,
      `\n=== AVAILABLE TEMPLATES ===\n${templatesText || 'No templates'}`,
      `\n=== ALL SAVED FUNNELS ===\n${allFunnelsText || 'None'}`,
      funnelPagesText ? `\n=== FRONT END FUNNEL (active steps) ===\n${funnelPagesText}` : '',
    ].filter(Boolean).join('\n');
  }, [archivedFunnels, products, templates, funnelPages]);

  const handleChatSend = async (funnelId: string) => {
    if (!chatInput.trim() || isChatLoading) return;
    const newMsg = { role: 'user' as const, content: chatInput.trim() };
    const msgs = [...(chatMessages[funnelId] || []), newMsg];
    setChatMessages(prev => ({ ...prev, [funnelId]: msgs }));
    setChatInput('');
    setIsChatLoading(true);
    try {
      const res = await fetch('/api/funnel-brief/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs,
          funnel_context: buildFullContext(funnelId),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChatMessages(prev => ({ ...prev, [funnelId]: [...msgs, { role: 'assistant', content: data.reply }] }));
    } catch (error) {
      setChatMessages(prev => ({ ...prev, [funnelId]: [...msgs, { role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Unknown'}` }] }));
    } finally {
      setIsChatLoading(false);
    }
  };

  // By Type: analysis
  const runTypeAnalysis = useCallback(async (typeValue: string, pages: { name: string; url_to_swipe: string; funnel_name: string; prompt: string; product_name: string }[]) => {
    if (analyzingTypeIds.has(typeValue)) return;
    setAnalyzingTypeIds(prev => new Set(prev).add(typeValue));
    try {
      const steps = pages.map((p, i) => ({
        step_index: i + 1,
        name: p.name,
        page_type: typeValue,
        url_to_swipe: p.url_to_swipe,
        prompt: p.prompt || '',
        product_name: p.product_name || '',
      }));
      const res = await fetch('/api/funnel-brief/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnel_name: `Collection "${getPageTypeLabel(typeValue)}" (${pages.length} pages)`, steps }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTypeAnalysis(prev => {
        const next = { ...prev, [typeValue]: data.analysis };
        try { localStorage.setItem('type_analyses', JSON.stringify(next)); } catch {}
        return next;
      });
    } catch (error) {
      console.error('Type analysis failed:', error);
    } finally {
      setAnalyzingTypeIds(prev => { const n = new Set(prev); n.delete(typeValue); return n; });
    }
  }, [analyzingTypeIds]);

  // Auto-trigger type analysis on expand
  useEffect(() => {
    expandedTypes.forEach(typeValue => {
      if (autoAnalyzedTypesRef.current.has(typeValue)) return;
      if (typeAnalysis[typeValue]) return;
      const pages = pagesByType[typeValue];
      if (pages && pages.length > 0) {
        autoAnalyzedTypesRef.current.add(typeValue);
        runTypeAnalysis(typeValue, pages);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedTypes]);

  const buildTypeContext = useCallback((typeValue: string) => {
    const pages = pagesByType[typeValue] || [];
    const pagesText = pages.map((p, i) => `${i + 1}. "${p.name}" — Funnel: ${p.funnel_name} — URL: ${p.url_to_swipe || 'N/A'} — Product: ${p.product_name || 'N/A'}`).join('\n');
    const brief = typeAnalysis[typeValue] || '';
    const productsText = (products || []).map(p => `- ${p.name}: ${p.description} (€${p.price})`).join('\n');
    const templatesText = (templates || []).slice(0, 20).map(t => `- ${t.name} (${t.pageType})`).join('\n');
    const allFunnelsText = archivedFunnels.map(f => `- "${f.name}" (${f.total_steps} step)`).join('\n');
    const allTypesText = Object.entries(pagesByType).map(([t, ps]) => `- ${getPageTypeLabel(t)}: ${ps.length} pages`).join('\n');
    const funnelPagesText = (funnelPages || []).map((p, i) => `Step ${i + 1}: "${p.name}" (${p.pageType})`).join('\n');

    return [
      `=== COLLECTION BY TYPE: "${getPageTypeLabel(typeValue)}" ===`,
      `${pages.length} pages of type "${getPageTypeLabel(typeValue)}":`,
      pagesText,
      brief ? `\n=== AI BRIEF ===\n${brief}` : '',
      `\n=== ALL TYPES IN ARCHIVE ===\n${allTypesText}`,
      `\n=== AVAILABLE PRODUCTS ===\n${productsText || 'No products'}`,
      `\n=== AVAILABLE TEMPLATES ===\n${templatesText || 'No templates'}`,
      `\n=== ALL SAVED FUNNELS ===\n${allFunnelsText || 'None'}`,
      funnelPagesText ? `\n=== FRONT END FUNNEL (active steps) ===\n${funnelPagesText}` : '',
    ].filter(Boolean).join('\n');
  }, [pagesByType, typeAnalysis, products, templates, archivedFunnels, funnelPages]);

  const handleTypeChatSend = async (typeValue: string) => {
    if (!typeChatInput.trim() || isTypeChatLoading) return;
    const newMsg = { role: 'user' as const, content: typeChatInput.trim() };
    const msgs = [...(typeChatMessages[typeValue] || []), newMsg];
    setTypeChatMessages(prev => ({ ...prev, [typeValue]: msgs }));
    setTypeChatInput('');
    setIsTypeChatLoading(true);
    try {
      const res = await fetch('/api/funnel-brief/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs,
          funnel_context: buildTypeContext(typeValue),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTypeChatMessages(prev => ({ ...prev, [typeValue]: [...msgs, { role: 'assistant', content: data.reply }] }));
    } catch (error) {
      setTypeChatMessages(prev => ({ ...prev, [typeValue]: [...msgs, { role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Unknown'}` }] }));
    } finally {
      setIsTypeChatLoading(false);
    }
  };

  // Search
  const [archiveSearch, setArchiveSearch] = useState('');

  const filteredArchivedFunnels = useMemo(() => {
    if (!archiveSearch.trim()) return archivedFunnels;
    const q = archiveSearch.toLowerCase();
    return archivedFunnels.filter(f => {
      if (f.name.toLowerCase().includes(q)) return true;
      const steps = (f.steps as { name: string; page_type: string }[]) || [];
      return steps.some(s => s.name.toLowerCase().includes(q) || s.page_type.toLowerCase().includes(q));
    });
  }, [archivedFunnels, archiveSearch]);

  const filteredPagesByType = useMemo(() => {
    if (!archiveSearch.trim()) return pagesByType;
    const q = archiveSearch.toLowerCase();
    const result: typeof pagesByType = {};
    Object.entries(pagesByType).forEach(([type, pages]) => {
      const filtered = pages.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.funnel_name.toLowerCase().includes(q) ||
        getPageTypeLabel(type).toLowerCase().includes(q)
      );
      if (filtered.length > 0) result[type] = filtered;
    });
    return result;
  }, [pagesByType, archiveSearch]);

  const [activeTab, setActiveTab] = useState<TemplateCategory>('standard');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTemplate, setNewTemplate] = useState<NewTemplateForm>(emptyForm);
  const [tagInput, setTagInput] = useState('');
  const [editTagInput, setEditTagInput] = useState('');
  const [selectedFilterTags, setSelectedFilterTags] = useState<string[]>([]);
  const [selectedFormatFilter, setSelectedFormatFilter] = useState<TemplateViewFormat | 'all'>('all');
  const [expandedPreviews, setExpandedPreviews] = useState<string[]>([]);
  const [fullscreenPreview, setFullscreenPreview] = useState<{ isOpen: boolean; url: string; name: string; viewFormat: TemplateViewFormat }>({
    isOpen: false,
    url: '',
    name: '',
    viewFormat: 'desktop',
  });
  const [pagePreview, setPagePreview] = useState<{ isOpen: boolean; url: string; name: string; pageType: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!pagePreview?.isOpen || !pagePreview.url) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewHtml(null);
    fetch('/api/proxy-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pagePreview.url }),
    })
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.html) setPreviewHtml(data.html);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [pagePreview?.isOpen, pagePreview?.url]);
  
  // Custom page types management
  const [showPageTypeManager, setShowPageTypeManager] = useState(false);
  const [newCustomPageType, setNewCustomPageType] = useState('');

  // Combine built-in and custom page types
  const allPageTypeOptions: PageTypeOption[] = useMemo(() => {
    const customOptions: PageTypeOption[] = (customPageTypes || []).map(ct => ({
      value: ct.value,
      label: ct.label,
      category: 'custom' as const,
    }));
    return [...BUILT_IN_PAGE_TYPE_OPTIONS, ...customOptions];
  }, [customPageTypes]);

  // Group page types by category for select dropdown
  const groupedPageTypes = useMemo(() => {
    const groups: Record<string, PageTypeOption[]> = {};
    PAGE_TYPE_CATEGORIES.forEach(cat => {
      groups[cat.value] = allPageTypeOptions.filter(opt => opt.category === cat.value);
    });
    return groups;
  }, [allPageTypeOptions]);

  // Handle adding custom page type
  const handleAddCustomPageType = () => {
    if (newCustomPageType.trim()) {
      addCustomPageType(newCustomPageType.trim());
      setNewCustomPageType('');
    }
  };

  // Filter templates by category (for tab view when no tag filter)
  const categoryTemplates = useMemo(() => {
    return (templates || []).filter(t => (t.category || 'standard') === activeTab);
  }, [templates, activeTab]);

  // Get all unique tags from ALL templates (to filter e.g. "all nutra funnels")
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    (templates || []).forEach(t => t.tags?.forEach(tag => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [templates]);

  // When tag filter is active: show templates from ALL categories that match the tag(s)
  // When no tag selected: show only current category (standard or quiz)
  const filteredTemplates = useMemo(() => {
    const baseList = selectedFilterTags.length > 0
      ? (templates || []).filter(t =>
          selectedFilterTags.some(filterTag => t.tags?.includes(filterTag))
        )
      : categoryTemplates;

    let filtered = baseList;
    if (selectedFormatFilter !== 'all') {
      filtered = filtered.filter(t => (t.viewFormat || 'desktop') === selectedFormatFilter);
    }
    return filtered;
  }, [templates, categoryTemplates, selectedFilterTags, selectedFormatFilter]);

  // Count templates per category
  const standardCount = (templates || []).filter(t => (t.category || 'standard') === 'standard').length;
  const quizCount = (templates || []).filter(t => t.category === 'quiz').length;

  const handleAddTemplate = () => {
    if (!newTemplate.name.trim() || !newTemplate.sourceUrl.trim()) return;
    addTemplate({
      ...newTemplate,
      category: activeTab, // Use current tab as category
    });
    setNewTemplate({ ...emptyForm, category: activeTab });
    setShowAddForm(false);
  };

  const addTagToNew = () => {
    if (tagInput.trim() && !newTemplate.tags.includes(tagInput.trim().toLowerCase())) {
      setNewTemplate({
        ...newTemplate,
        tags: [...newTemplate.tags, tagInput.trim().toLowerCase()],
      });
      setTagInput('');
    }
  };

  const removeTagFromNew = (tag: string) => {
    setNewTemplate({
      ...newTemplate,
      tags: newTemplate.tags.filter(t => t !== tag),
    });
  };

  const addTagToEdit = (templateId: string, currentTags: string[]) => {
    if (editTagInput.trim() && !currentTags.includes(editTagInput.trim().toLowerCase())) {
      updateTemplate(templateId, {
        tags: [...currentTags, editTagInput.trim().toLowerCase()],
      });
      setEditTagInput('');
    }
  };

  const removeTagFromEdit = (templateId: string, currentTags: string[], tagToRemove: string) => {
    updateTemplate(templateId, {
      tags: currentTags.filter(t => t !== tagToRemove),
    });
  };

  const toggleFilterTag = (tag: string) => {
    setSelectedFilterTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const togglePreviewExpanded = (templateId: string) => {
    setExpandedPreviews(prev =>
      prev.includes(templateId)
        ? prev.filter(id => id !== templateId)
        : [...prev, templateId]
    );
  };

  const isValidUrl = (url: string) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const handleTabChange = (tab: TemplateCategory) => {
    setActiveTab(tab);
    setSelectedFilterTags([]);
    setShowAddForm(false);
    setEditingId(null);
  };

  return (
    <div className="min-h-screen">
      <Header
        title="My Archive"
        subtitle="Templates, saved funnels and pages organized by type"
      />

      <div className="p-6">
        {/* Main View Tabs + Search */}
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1.5">
            <button
              onClick={() => setMainView('templates')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                mainView === 'templates' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <FileCode className="w-4 h-4" />
              Templates
            </button>
            <button
              onClick={() => setMainView('funnels')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                mainView === 'funnels' ? 'bg-white text-green-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Archive className="w-4 h-4" />
              Saved Funnels
              {archivedFunnels.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">{archivedFunnels.length}</span>
              )}
            </button>
            <button
              onClick={() => setMainView('quiz')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                mainView === 'quiz' ? 'bg-white text-orange-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <HelpCircle className="w-4 h-4" />
              Quiz
              {quizCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full text-xs">{quizCount}</span>
              )}
            </button>
            <button
              onClick={() => setMainView('byType')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                mainView === 'byType' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <FolderOpen className="w-4 h-4" />
              By Type
              {Object.keys(pagesByType).length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full text-xs">{Object.keys(pagesByType).length}</span>
              )}
            </button>
          </div>

          {(mainView !== 'templates') && (
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={archiveSearch}
                onChange={(e) => setArchiveSearch(e.target.value)}
                placeholder="Search funnels, pages, types..."
                className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              {archiveSearch && (
                <button onClick={() => setArchiveSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* ============ SAVED FUNNELS VIEW ============ */}
        {mainView === 'funnels' && (
          <div className="space-y-6">
            {filteredArchivedFunnels.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
                <Archive className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-lg font-medium">{archiveSearch ? 'No results found' : 'No saved funnels'}</p>
                <p className="text-gray-400 text-sm mt-1">{archiveSearch ? 'Try a different search term' : 'Go to Front End Funnel and click "Save" to archive a funnel'}</p>
              </div>
            ) : (
              filteredArchivedFunnels.map((funnel) => {
                const steps = (funnel.steps as { step_index: number; name: string; page_type: string; url_to_swipe: string; prompt: string; template_name: string; product_name: string; swipe_status: string; feedback: string }[]) || [];
                const isExpanded = expandedFunnelIds.includes(funnel.id);
                const allSelected = isFunnelFullySelected(funnel);
                return (
                  <div key={funnel.id} className={`bg-white rounded-xl border overflow-hidden shadow-sm transition-colors ${allSelected ? 'border-green-300 bg-green-50/30' : 'border-gray-200'}`}>
                    <div className="flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition-colors">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleFunnel(funnel); }}
                        className="flex-shrink-0"
                        title="Select entire funnel"
                      >
                        {allSelected
                          ? <CheckSquare className="w-5 h-5 text-green-600" />
                          : <Square className="w-5 h-5 text-gray-300 hover:text-gray-500" />
                        }
                      </button>
                      <div
                        className="flex items-center gap-3 flex-1 cursor-pointer"
                        onClick={() => setExpandedFunnelIds(prev => prev.includes(funnel.id) ? prev.filter(id => id !== funnel.id) : [...prev, funnel.id])}
                      >
                        {isExpanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                        <div className="flex-1">
                          <span className="font-semibold text-gray-900 text-base">{funnel.name}</span>
                          <span className="ml-3 text-sm text-gray-400">{funnel.total_steps} step</span>
                        </div>
                        <span className="text-xs text-gray-400">{new Date(funnel.created_at).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete funnel "${funnel.name}"?`)) deleteArchivedFunnel(funnel.id);
                        }}
                        className="ml-2 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {isExpanded && steps.length > 0 && (
                      <div className="border-t border-gray-100 p-5 space-y-5">
                        {/* Cards grid */}
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                          {steps.map((s, i) => {
                            const sp: SelectedPage = { name: s.name, page_type: s.page_type, url_to_swipe: s.url_to_swipe, prompt: s.prompt || '', funnel_name: funnel.name };
                            const checked = isPageSelected(sp);
                            return (
                              <div
                                key={i}
                                onClick={() => s.url_to_swipe ? setPagePreview({ isOpen: true, url: s.url_to_swipe, name: s.name, pageType: s.page_type }) : togglePage(sp)}
                                className={`group bg-white rounded-xl border overflow-hidden cursor-pointer transition-all ${
                                  checked ? 'border-green-400 ring-2 ring-green-200 shadow-md' : 'border-gray-200 hover:shadow-lg hover:border-blue-300'
                                }`}
                              >
                                <div className="relative w-full h-[180px] overflow-hidden">
                                  {(() => {
                                    const isQuizFunnel = funnel.section === 'quiz';
                                    const isRealUrl = !isQuizFunnel && s.url_to_swipe && /^https?:\/\/.+\..+/.test(s.url_to_swipe);
                                    if (isRealUrl) {
                                      return <CachedScreenshot url={s.url_to_swipe} alt={s.name} className="w-full" height="180px" />;
                                    }
                                    const stepColors = [
                                      'from-blue-500 to-indigo-600',
                                      'from-emerald-500 to-teal-600',
                                      'from-orange-500 to-red-600',
                                      'from-purple-500 to-pink-600',
                                      'from-cyan-500 to-blue-600',
                                      'from-rose-500 to-fuchsia-600',
                                      'from-amber-500 to-orange-600',
                                      'from-green-500 to-emerald-600',
                                      'from-violet-500 to-purple-600',
                                      'from-teal-500 to-cyan-600',
                                      'from-red-500 to-rose-600',
                                      'from-indigo-500 to-violet-600',
                                      'from-fuchsia-500 to-pink-600',
                                      'from-sky-500 to-blue-600',
                                      'from-lime-500 to-green-600',
                                    ];
                                    const colorClass = stepColors[i % stepColors.length];
                                    const isQuestion = /^q\d/i.test(s.name) || s.page_type === 'quiz_funnel';
                                    const isTransition = /transition/i.test(s.name) || /bridge/i.test(s.name);
                                    const isResult = /result/i.test(s.name) || /scarcity/i.test(s.name) || /gate/i.test(s.name);
                                    const icon = isQuestion ? '?' : isTransition ? '→' : isResult ? '★' : '•';
                                    return (
                                      <div className={`w-full h-full bg-gradient-to-br ${colorClass} flex flex-col items-center justify-center p-4 text-center relative`}>
                                        <div className="absolute top-3 right-3 px-2 py-0.5 bg-white/20 rounded-full text-[9px] text-white/80 font-medium backdrop-blur-sm">
                                          {isQuestion ? 'Question' : isTransition ? 'Transition' : isResult ? 'Result' : getPageTypeLabel(s.page_type)}
                                        </div>
                                        <span className="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-white font-bold text-2xl mb-3 shadow-lg">{icon}</span>
                                        <span className="text-white font-bold text-sm line-clamp-2 leading-snug drop-shadow-sm">{s.name}</span>
                                        <span className="mt-2 text-white/70 text-[11px] font-medium">Step {i + 1}</span>
                                      </div>
                                    );
                                  })()}
                                  <div className="absolute top-2 left-2" onClick={(e) => { e.stopPropagation(); togglePage(sp); }}>
                                    {checked
                                      ? <CheckSquare className="w-5 h-5 text-green-600 drop-shadow cursor-pointer" />
                                      : <Square className="w-5 h-5 text-white/70 drop-shadow group-hover:text-white cursor-pointer" />
                                    }
                                  </div>
                                  {s.url_to_swipe && /^https?:\/\//.test(s.url_to_swipe) && (
                                    <a
                                      href={s.url_to_swipe}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 rounded-full p-1.5 shadow"
                                    >
                                      <ExternalLink className="w-3.5 h-3.5 text-gray-700" />
                                    </a>
                                  )}
                                </div>
                                <div className="p-3">
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <span className="text-xs font-bold text-gray-400 bg-gray-100 rounded-full w-5 h-5 flex items-center justify-center">{s.step_index}</span>
                                    <span className="font-semibold text-sm text-gray-900 truncate flex-1">{s.name}</span>
                                  </div>
                                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700">{getPageTypeLabel(s.page_type)}</span>
                                  {s.product_name && (
                                    <p className="text-[10px] text-gray-400 mt-1 truncate">{s.product_name}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* AI Analysis Section */}
                        <div className="border-t border-gray-200 pt-5 space-y-5">
                          {/* Brief - loading or content */}
                          {analyzingFunnelIds.has(funnel.id) ? (
                            <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border border-purple-200 p-8 flex items-center justify-center gap-3">
                              <Loader2 className="w-5 h-5 animate-spin text-purple-600" />
                              <span className="text-purple-700 font-medium">AI Analysis in progress...</span>
                            </div>
                          ) : funnel.analysis ? (
                            <>
                              <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border border-purple-200 p-6">
                                <div className="flex items-center gap-2 mb-4">
                                  <Sparkles className="w-5 h-5 text-purple-600" />
                                  <h4 className="font-bold text-gray-900 text-base">AI Brief — {funnel.name}</h4>
                                  <button
                                    onClick={() => runAnalysis(funnel)}
                                    className="ml-auto flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 bg-purple-100 hover:bg-purple-200 px-3 py-1.5 rounded-lg transition-colors"
                                  >
                                    <Sparkles className="w-3 h-3" />
                                    Regenerate
                                  </button>
                                </div>
                                <div className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap leading-relaxed">
                                  {funnel.analysis}
                                </div>
                              </div>

                              {/* Chat */}
                              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                                <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                                  <MessageCircle className="w-4 h-4 text-indigo-600" />
                                  <span className="font-semibold text-sm text-gray-900">Funnel Chat</span>
                                  <span className="text-xs text-gray-400 ml-1">Discuss next steps with AI</span>
                                </div>

                                <div className="max-h-[400px] overflow-y-auto p-4 space-y-3">
                                  {(!chatMessages[funnel.id] || chatMessages[funnel.id].length === 0) && (
                                    <p className="text-sm text-gray-400 text-center py-6">Write a message to start discussing the funnel...</p>
                                  )}
                                  {(chatMessages[funnel.id] || []).map((msg, mi) => (
                                    <div key={mi} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                      <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                                        msg.role === 'user'
                                          ? 'bg-indigo-600 text-white rounded-br-md'
                                          : 'bg-gray-100 text-gray-800 rounded-bl-md'
                                      }`}>
                                        {msg.content}
                                      </div>
                                    </div>
                                  ))}
                                  {isChatLoading && (
                                    <div className="flex justify-start">
                                      <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
                                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                      </div>
                                    </div>
                                  )}
                                </div>

                                <div className="border-t border-gray-200 p-3 flex gap-2">
                                  <input
                                    type="text"
                                    value={activeChatFunnelId === funnel.id ? chatInput : ''}
                                    onChange={(e) => { setActiveChatFunnelId(funnel.id); setChatInput(e.target.value); }}
                                    onFocus={() => setActiveChatFunnelId(funnel.id)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(funnel.id); } }}
                                    placeholder="How can I improve this funnel?"
                                    className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                                    disabled={isChatLoading}
                                  />
                                  <button
                                    onClick={() => handleChatSend(funnel.id)}
                                    disabled={isChatLoading || !(activeChatFunnelId === funnel.id && chatInput.trim())}
                                    className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    <Send className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ============ BY TYPE VIEW ============ */}
        {mainView === 'byType' && (
          <div className="space-y-4">
            {Object.keys(filteredPagesByType).length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
                <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-lg font-medium">{archiveSearch ? 'No results found' : 'No archived pages'}</p>
                <p className="text-gray-400 text-sm mt-1">{archiveSearch ? 'Try a different search term' : 'Save funnels to see them organized by type'}</p>
              </div>
            ) : (
              Object.entries(filteredPagesByType)
                .sort(([a], [b]) => getPageTypeLabel(a).localeCompare(getPageTypeLabel(b)))
                .map(([typeValue, pages]) => {
                  const isOpen = expandedTypes.includes(typeValue);
                  const catInfo = PAGE_TYPE_CATEGORIES.find(c => {
                    const opt = BUILT_IN_PAGE_TYPE_OPTIONS.find(o => o.value === typeValue);
                    return opt && c.value === opt.category;
                  });
                  const colorClass = catInfo?.color || 'bg-gray-100 text-gray-700';
                  return (
                    <div key={typeValue} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                      <div
                        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                        onClick={() => setExpandedTypes(prev => prev.includes(typeValue) ? prev.filter(t => t !== typeValue) : [...prev, typeValue])}
                      >
                        {isOpen ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                        <FolderOpen className="w-5 h-5 text-amber-500" />
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${colorClass}`}>{getPageTypeLabel(typeValue)}</span>
                        <span className="text-sm text-gray-400 ml-auto">{pages.length} {pages.length === 1 ? 'page' : 'pages'}</span>
                      </div>
                      {isOpen && (
                        <div className="border-t border-gray-100 p-5 space-y-5">
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                            {pages.map((p, i) => {
                              const sp: SelectedPage = { name: p.name, page_type: typeValue, url_to_swipe: p.url_to_swipe, prompt: p.prompt || '', funnel_name: p.funnel_name };
                              const checked = isPageSelected(sp);
                              return (
                                <div
                                  key={i}
                                  onClick={() => p.url_to_swipe ? setPagePreview({ isOpen: true, url: p.url_to_swipe, name: p.name, pageType: typeValue }) : togglePage(sp)}
                                  className={`group bg-white rounded-xl border overflow-hidden cursor-pointer transition-all ${
                                    checked ? 'border-green-400 ring-2 ring-green-200 shadow-md' : 'border-gray-200 hover:shadow-lg hover:border-purple-300'
                                  }`}
                                >
                                  <div className="relative w-full h-[180px] overflow-hidden">
                                    {(() => {
                                      const isRealUrl = p.url_to_swipe && /^https?:\/\/.+\..+/.test(p.url_to_swipe);
                                      if (isRealUrl) {
                                        return <CachedScreenshot url={p.url_to_swipe} alt={p.name} className="w-full" height="180px" />;
                                      }
                                      const hue = (i * 47 + 280) % 360;
                                      return (
                                        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center" style={{ background: `linear-gradient(135deg, hsl(${hue}, 50%, 55%), hsl(${(hue + 40) % 360}, 55%, 45%))` }}>
                                          <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-lg mb-2">{i + 1}</span>
                                          <span className="text-white/90 text-xs font-medium line-clamp-2 leading-relaxed">{p.name}</span>
                                          <span className="mt-1 px-2 py-0.5 bg-white/20 rounded-full text-[9px] text-white/80 font-medium">{getPageTypeLabel(typeValue)}</span>
                                        </div>
                                      );
                                    })()}
                                    <div className="absolute top-2 left-2" onClick={(e) => { e.stopPropagation(); togglePage(sp); }}>
                                      {checked
                                        ? <CheckSquare className="w-5 h-5 text-green-600 drop-shadow cursor-pointer" />
                                        : <Square className="w-5 h-5 text-white/70 drop-shadow group-hover:text-white cursor-pointer" />
                                      }
                                    </div>
                                    {p.url_to_swipe && /^https?:\/\//.test(p.url_to_swipe) && (
                                      <a
                                        href={p.url_to_swipe}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 rounded-full p-1.5 shadow"
                                      >
                                        <ExternalLink className="w-3.5 h-3.5 text-gray-700" />
                                      </a>
                                    )}
                                  </div>
                                  <div className="p-3">
                                    <p className="font-semibold text-sm text-gray-900 truncate">{p.name}</p>
                                    <p className="text-[10px] text-gray-400 mt-0.5 truncate">from: {p.funnel_name}</p>
                                    {p.product_name && (
                                      <p className="text-[10px] text-gray-400 truncate">{p.product_name}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* AI Analysis Section for Type */}
                          <div className="border-t border-gray-200 pt-5 space-y-5">
                            {analyzingTypeIds.has(typeValue) ? (
                              <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border border-purple-200 p-8 flex items-center justify-center gap-3">
                                <Loader2 className="w-5 h-5 animate-spin text-purple-600" />
                                <span className="text-purple-700 font-medium">AI Analysis in progress...</span>
                              </div>
                            ) : typeAnalysis[typeValue] ? (
                              <>
                                <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl border border-purple-200 p-6">
                                  <div className="flex items-center gap-2 mb-4">
                                    <Sparkles className="w-5 h-5 text-purple-600" />
                                    <h4 className="font-bold text-gray-900 text-base">AI Brief — {getPageTypeLabel(typeValue)} ({pages.length} pages)</h4>
                                    <button
                                      onClick={() => runTypeAnalysis(typeValue, pages)}
                                      className="ml-auto flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 bg-purple-100 hover:bg-purple-200 px-3 py-1.5 rounded-lg transition-colors"
                                    >
                                      <Sparkles className="w-3 h-3" />
                                      Regenerate
                                    </button>
                                  </div>
                                  <div className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap leading-relaxed">
                                    {typeAnalysis[typeValue]}
                                  </div>
                                </div>

                                {/* Chat for Type */}
                                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                                  <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                                    <MessageCircle className="w-4 h-4 text-indigo-600" />
                                    <span className="font-semibold text-sm text-gray-900">Chat on {getPageTypeLabel(typeValue)}</span>
                                    <span className="text-xs text-gray-400 ml-1">Discuss these page types with AI</span>
                                  </div>

                                  <div className="max-h-[400px] overflow-y-auto p-4 space-y-3">
                                    {(!typeChatMessages[typeValue] || typeChatMessages[typeValue].length === 0) && (
                                      <p className="text-sm text-gray-400 text-center py-6">Write a message to discuss pages of type {getPageTypeLabel(typeValue)}...</p>
                                    )}
                                    {(typeChatMessages[typeValue] || []).map((msg, mi) => (
                                      <div key={mi} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                                          msg.role === 'user'
                                            ? 'bg-indigo-600 text-white rounded-br-md'
                                            : 'bg-gray-100 text-gray-800 rounded-bl-md'
                                        }`}>
                                          {msg.content}
                                        </div>
                                      </div>
                                    ))}
                                    {isTypeChatLoading && activeTypeChatId === typeValue && (
                                      <div className="flex justify-start">
                                        <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
                                          <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                        </div>
                                      </div>
                                    )}
                                  </div>

                                  <div className="border-t border-gray-200 p-3 flex gap-2">
                                    <input
                                      type="text"
                                      value={activeTypeChatId === typeValue ? typeChatInput : ''}
                                      onChange={(e) => { setActiveTypeChatId(typeValue); setTypeChatInput(e.target.value); }}
                                      onFocus={() => setActiveTypeChatId(typeValue)}
                                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTypeChatSend(typeValue); } }}
                                      placeholder={`Analyze ${getPageTypeLabel(typeValue)} pages...`}
                                      className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                                      disabled={isTypeChatLoading}
                                    />
                                    <button
                                      onClick={() => handleTypeChatSend(typeValue)}
                                      disabled={isTypeChatLoading || !(activeTypeChatId === typeValue && typeChatInput.trim())}
                                      className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    >
                                      <Send className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        )}

        {/* ============ QUIZ VIEW ============ */}
        {mainView === 'quiz' && (() => {
          const quizTemplates = (templates || []).filter(t => t.category === 'quiz');
          const quizArchived = (archivedFunnels || []).filter(f => f.section === 'quiz');
          const q = archiveSearch.toLowerCase();
          const quizFiltered = archiveSearch.trim()
            ? quizTemplates.filter(t =>
                t.name.toLowerCase().includes(q) ||
                (t.tags || []).some(tag => tag.toLowerCase().includes(q))
              )
            : quizTemplates;
          const quizArchivedFiltered = archiveSearch.trim()
            ? quizArchived.filter(f => f.name.toLowerCase().includes(q))
            : quizArchived;
          const totalCount = quizFiltered.length + quizArchivedFiltered.length;
          return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Quiz Templates</h2>
                <p className="text-sm text-gray-500 mt-0.5">Start from a proven quiz funnel — fully built and ready to customise.</p>
              </div>
              <button
                onClick={() => {
                  setActiveTab('quiz');
                  setShowAddForm(!showAddForm);
                  setMainView('templates');
                }}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Quiz
              </button>
            </div>

            {totalCount === 0 ? (
              <div className="text-center py-16">
                <HelpCircle className="w-16 h-16 text-gray-200 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-500 mb-2">
                  {quizTemplates.length === 0 && quizArchived.length === 0 ? 'No quiz templates yet' : 'No results'}
                </h3>
                <p className="text-sm text-gray-400">
                  {quizTemplates.length === 0 && quizArchived.length === 0
                    ? 'Add your first quiz template or ask Merlino to save a funnel as quiz'
                    : 'Try a different search term'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Create from Scratch card */}
                <button
                  onClick={() => {
                    setActiveTab('quiz');
                    setShowAddForm(true);
                    setMainView('templates');
                  }}
                  className="border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center py-16 hover:border-gray-400 hover:bg-gray-50 transition-all group min-h-[360px]"
                >
                  <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4 group-hover:bg-gray-200 transition-colors">
                    <Plus className="w-7 h-7 text-gray-400 group-hover:text-gray-600" />
                  </div>
                  <span className="text-sm font-bold text-gray-700">Create from Scratch</span>
                  <span className="text-xs text-gray-400 mt-1">Start with a blank quiz funnel</span>
                </button>

                {/* Quiz Templates (from swipe_templates) */}
                {quizFiltered.map((template) => {
                  const previewUrl = template.screenshot_url || template.url_to_swipe;
                  const niche = (template.tags || []).find(t => !['quiz', 'funnel', 'lead-magnet', 'survey'].includes(t.toLowerCase()));
                  return (
                    <div key={template.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all group relative">
                      <div className="relative">
                        {previewUrl ? (
                          <CachedScreenshot url={previewUrl} alt={template.name} height="280px" className="w-full" />
                        ) : (
                          <div className="h-[280px] bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                            <HelpCircle className="w-16 h-16 text-slate-300" />
                          </div>
                        )}
                        <div className="absolute top-3 left-3 flex items-center gap-2">
                          <span className="px-3 py-1 bg-purple-500/90 text-white rounded-lg text-xs font-semibold shadow-sm">Template</span>
                          {niche && (
                            <span className="px-3 py-1 bg-white/90 backdrop-blur-sm rounded-lg text-xs font-semibold text-gray-800 shadow-sm capitalize">{niche}</span>
                          )}
                        </div>
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                          {template.url_to_swipe && (
                            <button
                              onClick={() => setPagePreview({ isOpen: true, url: template.url_to_swipe, name: template.name, pageType: 'quiz' })}
                              className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-lg text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
                            >
                              <Eye className="w-4 h-4" /> Preview
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="p-5">
                        <h3 className="text-base font-bold text-gray-900 mb-1 line-clamp-1">{template.name}</h3>
                        {template.prompt && <p className="text-xs text-gray-500 line-clamp-2 mb-3 leading-relaxed">{template.prompt}</p>}
                        {template.tags && template.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-4">
                            {template.tags.slice(0, 4).map((tag, i) => (
                              <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-medium rounded-full">{tag}</span>
                            ))}
                            {template.tags.length > 4 && <span className="px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] rounded-full">+{template.tags.length - 4}</span>}
                          </div>
                        )}
                        {template.createdAt && (
                          <p className="text-[10px] text-gray-400 mb-3">Created: {new Date(template.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                        )}
                        <div className="flex items-center gap-2">
                          <button onClick={() => { setActiveTab('quiz'); setEditingId(template.id); setMainView('templates'); }}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-semibold hover:bg-slate-700 transition-colors">
                            Use this template <span className="text-xs">→</span>
                          </button>
                          <button onClick={() => { if (confirm('Delete this quiz template?')) deleteTemplate(template.id); }}
                            className="p-2.5 bg-gray-100 text-gray-500 rounded-xl hover:bg-red-50 hover:text-red-500 transition-colors" title="Delete">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Archived Quiz Funnels (from archived_funnels with section='quiz') */}
                {quizArchivedFiltered.map((funnel) => {
                  const steps = (funnel.steps as { url_to_swipe?: string; name?: string; page_type?: string }[]) || [];
                  const questionSteps = steps.filter(s => {
                    const n = (s.name || '').toLowerCase();
                    return n.includes('q') || n.includes('question') || n.includes('step') || s.page_type === 'quiz_funnel';
                  });
                  const displaySteps = questionSteps.length > 0 ? questionSteps : steps;
                  return (
                    <div key={funnel.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all group relative">
                      <div className="relative h-[280px] bg-gradient-to-br from-purple-600 via-indigo-600 to-blue-700 p-6 flex flex-col justify-between overflow-hidden">
                        <div className="absolute inset-0 opacity-10">
                          <div className="absolute top-4 right-4 w-32 h-32 border-2 border-white rounded-full" />
                          <div className="absolute bottom-8 left-8 w-20 h-20 border-2 border-white rounded-full" />
                          <div className="absolute top-1/2 left-1/2 w-48 h-48 border border-white rounded-full -translate-x-1/2 -translate-y-1/2" />
                        </div>
                        <div className="relative z-10">
                          <div className="flex items-center gap-2 mb-3">
                            <span className="px-3 py-1 bg-orange-500 text-white rounded-lg text-xs font-semibold shadow-sm">Saved Quiz</span>
                            <span className="px-2 py-1 bg-white/20 backdrop-blur-sm rounded-lg text-[10px] font-medium text-white shadow-sm">{funnel.total_steps} steps</span>
                          </div>
                          <h3 className="text-white font-bold text-lg leading-tight line-clamp-2 drop-shadow-sm">{funnel.name}</h3>
                        </div>
                        <div className="relative z-10 space-y-1.5">
                          {displaySteps.slice(0, 4).map((s, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">{i + 1}</span>
                              <span className="text-white/90 text-xs truncate">{s.name || `Step ${i + 1}`}</span>
                            </div>
                          ))}
                          {displaySteps.length > 4 && (
                            <span className="text-white/60 text-[10px] ml-7">+{displaySteps.length - 4} more steps</span>
                          )}
                        </div>
                      </div>
                      <div className="p-5">
                        <p className="text-[10px] text-gray-400 mb-3">
                          Saved: {new Date(funnel.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              setExpandedFunnelIds(prev => prev.includes(funnel.id) ? prev : [...prev, funnel.id]);
                              setMainView('funnels');
                            }}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-semibold hover:bg-slate-700 transition-colors"
                          >
                            View funnel <span className="text-xs">→</span>
                          </button>
                          <button onClick={() => { if (confirm('Delete this quiz funnel?')) deleteArchivedFunnel(funnel.id); }}
                            className="p-2.5 bg-gray-100 text-gray-500 rounded-xl hover:bg-red-50 hover:text-red-500 transition-colors" title="Delete">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>);
        })()}

        {/* ============ TEMPLATES VIEW ============ */}
        {mainView === 'templates' && <>
        {/* Template Library — Phase 1: template list to categorize and organize */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-slate-50 to-gray-50">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-slate-600" />
              Template Library
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Phase 1 — Save, categorize and organize funnels of different types.
            </p>
          </div>
          <div className="p-6">
            <ul className="space-y-3" role="list">
              {LIBRARY_TEMPLATES.map((entry, index) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-4 py-3 px-4 rounded-lg border border-gray-100 bg-gray-50/50 hover:bg-gray-50 transition-colors"
                >
                  <span className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-white border border-gray-200 text-sm font-medium text-gray-600">
                    {index + 1}
                  </span>
                  <span className="font-medium text-gray-900">{entry.name}</span>
                  <span className={`ml-auto px-2.5 py-1 rounded-full text-xs font-medium ${
                    entry.category === 'quiz'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}>
                    {entry.category === 'quiz' ? 'Quiz' : 'Standard'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Category Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6">
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => handleTabChange('standard')}
              className={`flex-1 flex items-center justify-center gap-3 px-6 py-4 font-medium transition-colors ${
                activeTab === 'standard'
                  ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/50'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <Layers className="w-5 h-5" />
              <span>Standard Templates</span>
              <span className={`px-2 py-0.5 rounded-full text-sm ${
                activeTab === 'standard' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {standardCount}
              </span>
            </button>
            <button
              onClick={() => handleTabChange('quiz')}
              className={`flex-1 flex items-center justify-center gap-3 px-6 py-4 font-medium transition-colors ${
                activeTab === 'quiz'
                  ? 'text-purple-600 border-b-2 border-purple-600 bg-purple-50/50'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <HelpCircle className="w-5 h-5" />
              <span>Quiz Templates</span>
              <span className={`px-2 py-0.5 rounded-full text-sm ${
                activeTab === 'quiz' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {quizCount}
              </span>
            </button>
          </div>

          {/* Tab Description */}
          <div className={`px-6 py-3 text-sm ${
            activeTab === 'standard' ? 'bg-blue-50 text-blue-800' : 'bg-purple-50 text-purple-800'
          }`}>
            {activeTab === 'standard' ? (
              <p><strong>Standard Templates:</strong> Landing pages, advertorials, checkouts, product pages and other traditional sales pages.</p>
            ) : (
              <p><strong>Quiz Templates:</strong> Quiz funnels, surveys, interactive quizzes and question-based lead magnets.</p>
            )}
          </div>
        </div>

        {/* Filter by Tags */}
        {allTags.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex items-center gap-3 mb-3">
              <Filter className="w-5 h-5 text-gray-500" />
              <span className="font-medium text-gray-700">Filter by Tag:</span>
              {selectedFilterTags.length > 0 && (
                <button
                  onClick={() => setSelectedFilterTags([])}
                  className="text-sm text-blue-600 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {allTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleFilterTag(tag)}
                  className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                    selectedFilterTags.includes(tag)
                      ? activeTab === 'standard' ? 'bg-blue-600 text-white' : 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setNewTemplate({ ...emptyForm, category: activeTab });
                setShowAddForm(true);
              }}
              className={`flex items-center gap-2 text-white px-4 py-2 rounded-lg transition-colors ${
                activeTab === 'standard' 
                  ? 'bg-blue-600 hover:bg-blue-700' 
                  : 'bg-purple-600 hover:bg-purple-700'
              }`}
            >
              <Plus className="w-4 h-4" />
              Add {activeTab === 'standard' ? 'Template' : 'Quiz Template'}
            </button>
            <span className="text-gray-500">
              {selectedFilterTags.length > 0
                ? `${filteredTemplates.length} templates with tag ${selectedFilterTags.join(', ')}`
                : `${filteredTemplates.length} of ${categoryTemplates.length} templates`}
            </span>
          </div>
          
          {/* Format Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Format:</span>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              <button
                onClick={() => setSelectedFormatFilter('all')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  selectedFormatFilter === 'all'
                    ? 'bg-gray-800 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setSelectedFormatFilter('desktop')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors flex items-center gap-1.5 border-l border-gray-200 ${
                  selectedFormatFilter === 'desktop'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <Monitor className="w-4 h-4" />
                Desktop
              </button>
              <button
                onClick={() => setSelectedFormatFilter('mobile')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors flex items-center gap-1.5 border-l border-gray-200 ${
                  selectedFormatFilter === 'mobile'
                    ? 'bg-green-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <Smartphone className="w-4 h-4" />
                Mobile
              </button>
            </div>
            <button
              onClick={() => setShowPageTypeManager(!showPageTypeManager)}
              className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors ml-4"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="text-sm hidden md:inline">Manage Page Types</span>
            </button>
          </div>
        </div>

        {/* Custom Page Types Manager */}
        {showPageTypeManager && (
          <div className="bg-indigo-50 rounded-lg shadow-sm border border-indigo-200 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-indigo-900 flex items-center gap-2">
                <FolderPlus className="w-5 h-5" />
                Custom Page Type Management
              </h3>
              <button
                onClick={() => setShowPageTypeManager(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <p className="text-sm text-indigo-700 mb-4">
              Create custom categories to organize your templates. Created categories are saved automatically.
            </p>

            {/* Add New Custom Page Type */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newCustomPageType}
                onChange={(e) => setNewCustomPageType(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddCustomPageType()}
                className="flex-1 px-3 py-2 border border-indigo-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white"
                placeholder="New category name (e.g.: Webinar, Newsletter, etc.)"
              />
              <button
                onClick={handleAddCustomPageType}
                disabled={!newCustomPageType.trim()}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {/* List of Custom Page Types */}
            {(customPageTypes || []).length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-indigo-800 mb-2">Custom Categories ({(customPageTypes || []).length})</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {(customPageTypes || []).map((pageType) => (
                    <div
                      key={pageType.value}
                      className="flex items-center justify-between bg-white px-3 py-2 rounded-lg border border-indigo-200"
                    >
                      <span className="text-sm font-medium text-gray-800">{pageType.label}</span>
                      <button
                        onClick={() => deleteCustomPageType(pageType.value)}
                        className="text-red-500 hover:text-red-700 p-1"
                        title="Delete category"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-4 text-indigo-600">
                <FolderPlus className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No custom categories. Create a new one!</p>
              </div>
            )}

            {/* Built-in Categories Info */}
            <div className="mt-6 pt-4 border-t border-indigo-200">
              <h4 className="text-sm font-medium text-indigo-800 mb-3">Built-in Categories</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {PAGE_TYPE_CATEGORIES.filter(c => c.value !== 'custom').map((category) => (
                  <div key={category.value} className="text-center">
                    <span className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${category.color}`}>
                      {category.label}
                    </span>
                    <p className="text-xs text-gray-500 mt-1">
                      {(groupedPageTypes[category.value] || []).length} types
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Add Template Form */}
        {showAddForm && (
          <div className={`rounded-lg shadow-sm border p-6 mb-6 ${
            activeTab === 'standard' 
              ? 'bg-white border-gray-200' 
              : 'bg-purple-50/30 border-purple-200'
          }`}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              {activeTab === 'standard' ? (
                <><Layers className="w-5 h-5 text-blue-600" /> New Standard Template</>
              ) : (
                <><HelpCircle className="w-5 h-5 text-purple-600" /> New Quiz Template</>
              )}
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Form Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Template Name *
                  </label>
                  <input
                    type="text"
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    placeholder={activeTab === 'standard' ? 'E.g.: Physical Product Landing' : 'E.g.: Quiz Skin Type'}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center justify-between">
                    <span>Page Type</span>
                    <button
                      type="button"
                      onClick={() => setShowPageTypeManager(!showPageTypeManager)}
                      className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                    >
                      <Settings className="w-3 h-3" />
                      Manage categories
                    </button>
                  </label>
                  <select
                    value={newTemplate.pageType}
                    onChange={(e) => setNewTemplate({ ...newTemplate, pageType: e.target.value as PageType })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  >
                    {PAGE_TYPE_CATEGORIES.map((category) => {
                      const categoryOptions = groupedPageTypes[category.value] || [];
                      if (categoryOptions.length === 0) return null;
                      return (
                        <optgroup key={category.value} label={category.label}>
                          {categoryOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Source URL *
                  </label>
                  <input
                    type="url"
                    value={newTemplate.sourceUrl}
                    onChange={(e) => setNewTemplate({ ...newTemplate, sourceUrl: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    placeholder="https://example.com/landing-page"
                  />
                </div>
                
                {/* View Format Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Template Format *
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setNewTemplate({ ...newTemplate, viewFormat: 'desktop' })}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                        newTemplate.viewFormat === 'desktop'
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <Monitor className="w-5 h-5" />
                      <span className="font-medium">Desktop</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewTemplate({ ...newTemplate, viewFormat: 'mobile' })}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                        newTemplate.viewFormat === 'mobile'
                          ? 'border-green-600 bg-green-50 text-green-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <Smartphone className="w-5 h-5" />
                      <span className="font-medium">Mobile</span>
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Select whether this template is optimized for desktop or mobile viewing
                  </p>
                </div>
                
                {/* Tags Input */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Tag className="w-4 h-4 inline mr-1" />
                    Tag
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTagToNew())}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                      placeholder={activeTab === 'standard' ? 'E.g.: nutra, supplements...' : 'E.g.: skincare, quiz, lead-magnet...'}
                    />
                    <button
                      type="button"
                      onClick={addTagToNew}
                      className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {newTemplate.tags.map((tag, index) => (
                      <span
                        key={index}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm ${
                          activeTab === 'standard' 
                            ? 'bg-blue-100 text-blue-800' 
                            : 'bg-purple-100 text-purple-800'
                        }`}
                      >
                        {tag}
                        <button
                          onClick={() => removeTagFromNew(tag)}
                          className="hover:opacity-70"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={newTemplate.description}
                    onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    rows={2}
                    placeholder="Optional template description..."
                  />
                </div>
              </div>

              {/* Preview Panel */}
              <div className="lg:border-l lg:pl-6">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700 flex items-center gap-2">
                    <Eye className="w-4 h-4" />
                    Template Preview
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                      newTemplate.viewFormat === 'mobile' 
                        ? 'bg-green-100 text-green-700' 
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {newTemplate.viewFormat === 'mobile' ? <Smartphone className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                      {newTemplate.viewFormat === 'mobile' ? 'Mobile' : 'Desktop'}
                    </span>
                  </label>
                  {isValidUrl(newTemplate.sourceUrl) && (
                    <button
                      onClick={() => setPagePreview({
                        isOpen: true,
                        url: newTemplate.sourceUrl,
                        name: newTemplate.name || 'New Template',
                        pageType: newTemplate.viewFormat,
                      })}
                      className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                    >
                      <Maximize2 className="w-4 h-4" />
                      Fullscreen
                    </button>
                  )}
                </div>
                {isValidUrl(newTemplate.sourceUrl) ? (
                  <div className={`border border-gray-300 rounded-lg overflow-hidden bg-gray-100 flex justify-center ${
                    newTemplate.viewFormat === 'mobile' ? 'py-4' : ''
                  }`}>
                    <iframe
                      src={newTemplate.sourceUrl}
                      className={`bg-white ${
                        newTemplate.viewFormat === 'mobile' 
                          ? 'w-[375px] h-[667px] rounded-lg shadow-lg' 
                          : 'w-full h-[400px]'
                      }`}
                      sandbox="allow-same-origin allow-scripts"
                      title="Template Preview"
                    />
                  </div>
                ) : (
                  <div className="border border-gray-300 rounded-lg h-[400px] bg-gray-50 flex items-center justify-center">
                    <div className="text-center text-gray-500">
                      <Eye className="w-12 h-12 mx-auto mb-2 opacity-30" />
                      <p>Enter a valid URL to see the preview</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t">
              <button
                onClick={() => { setShowAddForm(false); setNewTemplate(emptyForm); setTagInput(''); }}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddTemplate}
                disabled={!newTemplate.name.trim() || !newTemplate.sourceUrl.trim()}
                className={`px-4 py-2 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors ${
                  activeTab === 'standard'
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : 'bg-purple-600 hover:bg-purple-700'
                }`}
              >
                Save Template
              </button>
            </div>
          </div>
        )}

        {/* Templates Grid */}
        <div>
          {filteredTemplates.length === 0 ? (
            <div className="text-center py-16">
              {activeTab === 'standard' ? (
                <Layers className="w-16 h-16 text-gray-200 mx-auto mb-4" />
              ) : (
                <HelpCircle className="w-16 h-16 text-gray-200 mx-auto mb-4" />
              )}
              <h3 className="text-lg font-semibold text-gray-500 mb-2">
                {selectedFilterTags.length > 0
                  ? 'No templates with selected tags'
                  : categoryTemplates.length === 0
                    ? `No ${activeTab === 'standard' ? 'templates' : 'quiz templates'}`
                    : 'No templates found'}
              </h3>
              <p className="text-sm text-gray-400">
                {selectedFilterTags.length > 0
                  ? 'Try other tags or clear filters'
                  : categoryTemplates.length === 0
                    ? `Add your first ${activeTab === 'standard' ? 'template' : 'quiz template'} to get started`
                    : 'Try adjusting the filters'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Create from Scratch card */}
            <button
              onClick={() => {
                setNewTemplate({ ...emptyForm, category: activeTab });
                setShowAddForm(true);
              }}
              className="border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center py-16 hover:border-gray-400 hover:bg-gray-50 transition-all group min-h-[360px]"
            >
              <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4 group-hover:bg-gray-200 transition-colors">
                <Plus className="w-7 h-7 text-gray-400 group-hover:text-gray-600" />
              </div>
              <span className="text-sm font-bold text-gray-700">Create from Scratch</span>
              <span className="text-xs text-gray-400 mt-1">Start with a blank template</span>
            </button>

            {filteredTemplates.map((template) => {
              const templateCategory = (template.category || 'standard') as TemplateCategory;
              const previewUrl = template.screenshot_url || template.url_to_swipe || template.sourceUrl;

              if (editingId === template.id) {
              return (
              <div key={template.id} className="bg-white rounded-2xl border border-gray-200 p-5 col-span-full">
                <div className="flex-1">
                      {editingId === template.id && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                              <input
                                type="text"
                                value={template.name}
                                onChange={(e) => updateTemplate(template.id, { name: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Page Type</label>
                              <select
                                value={template.pageType}
                                onChange={(e) => updateTemplate(template.id, { pageType: e.target.value as PageType })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                              >
                                {PAGE_TYPE_CATEGORIES.map((category) => {
                                  const categoryOptions = groupedPageTypes[category.value] || [];
                                  if (categoryOptions.length === 0) return null;
                                  return (
                                    <optgroup key={category.value} label={category.label}>
                                      {categoryOptions.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  );
                                })}
                              </select>
                            </div>
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">Source URL</label>
                              <input
                                type="url"
                                value={template.sourceUrl}
                                onChange={(e) => updateTemplate(template.id, { sourceUrl: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                              />
                            </div>
                            
                            {/* Edit View Format */}
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-2">Template Format</label>
                              <div className="flex gap-3">
                                <button
                                  type="button"
                                  onClick={() => updateTemplate(template.id, { viewFormat: 'desktop' })}
                                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                                    (template.viewFormat || 'desktop') === 'desktop'
                                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                                  }`}
                                >
                                  <Monitor className="w-4 h-4" />
                                  <span className="font-medium">Desktop</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => updateTemplate(template.id, { viewFormat: 'mobile' })}
                                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                                    template.viewFormat === 'mobile'
                                      ? 'border-green-600 bg-green-50 text-green-700'
                                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                                  }`}
                                >
                                  <Smartphone className="w-4 h-4" />
                                  <span className="font-medium">Mobile</span>
                                </button>
                              </div>
                            </div>
                            
                            {/* Edit Tags */}
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                <Tag className="w-4 h-4 inline mr-1" />
                                Tag
                              </label>
                              <div className="flex gap-2 mb-2">
                                <input
                                  type="text"
                                  value={editTagInput}
                                  onChange={(e) => setEditTagInput(e.target.value)}
                                  onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addTagToEdit(template.id, template.tags || []))}
                                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                  placeholder="Add tag..."
                                />
                                <button
                                  type="button"
                                  onClick={() => addTagToEdit(template.id, template.tags || [])}
                                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                                >
                                  <Plus className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {(template.tags || []).map((tag, index) => (
                                  <span
                                    key={index}
                                    className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm ${
                                      templateCategory === 'standard' 
                                        ? 'bg-blue-100 text-blue-800' 
                                        : 'bg-purple-100 text-purple-800'
                                    }`}
                                  >
                                    {tag}
                                    <button
                                      onClick={() => removeTagFromEdit(template.id, template.tags || [], tag)}
                                      className="hover:opacity-70"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>

                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                              <textarea
                                value={template.description || ''}
                                onChange={(e) => updateTemplate(template.id, { description: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                rows={2}
                              />
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button
                              onClick={() => { setEditingId(null); setEditTagInput(''); }}
                              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                            >
                              <Save className="w-4 h-4" />
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
              </div>);
              }

              return (
              <div key={template.id} className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all group relative">
                <div className="relative">
                  {previewUrl ? (
                    <CachedScreenshot url={previewUrl} alt={template.name} height="280px" className="w-full" />
                  ) : (
                    <div className="h-[280px] bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                      <Layers className="w-16 h-16 text-slate-300" />
                    </div>
                  )}
                  <div className="absolute top-3 left-3 flex items-center gap-2">
                    <span className={`px-3 py-1 rounded-lg text-xs font-semibold shadow-sm ${
                      templateCategory === 'standard'
                        ? 'bg-blue-500/90 text-white' : 'bg-purple-500/90 text-white'
                    }`}>
                      {getPageTypeLabel(template.pageType)}
                    </span>
                    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium bg-white/90 backdrop-blur-sm shadow-sm ${
                      template.viewFormat === 'mobile' ? 'text-green-700' : 'text-gray-700'
                    }`}>
                      {template.viewFormat === 'mobile' ? <Smartphone className="w-3 h-3" /> : <Monitor className="w-3 h-3" />}
                      {template.viewFormat === 'mobile' ? 'Mobile' : 'Desktop'}
                    </span>
                  </div>
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <button
                      onClick={() => setPagePreview({ isOpen: true, url: template.sourceUrl, name: template.name, pageType: template.viewFormat || 'desktop' })}
                      className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-lg text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
                    >
                      <Eye className="w-4 h-4" />
                      Preview
                    </button>
                  </div>
                </div>
                <div className="p-5">
                  <h3 className="text-base font-bold text-gray-900 mb-1 line-clamp-1">{template.name}</h3>
                  {template.description && (
                    <p className="text-xs text-gray-500 line-clamp-2 mb-3 leading-relaxed">{template.description}</p>
                  )}
                  {template.tags && template.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {template.tags.slice(0, 4).map((tag, i) => (
                        <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-medium rounded-full">{tag}</span>
                      ))}
                      {template.tags.length > 4 && (
                        <span className="px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] rounded-full">+{template.tags.length - 4}</span>
                      )}
                    </div>
                  )}
                  {template.sourceUrl && (
                    <a href={template.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-blue-500 hover:underline truncate block mb-3">{template.sourceUrl}</a>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPagePreview({ isOpen: true, url: template.sourceUrl, name: template.name, pageType: template.viewFormat || 'desktop' })}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-semibold hover:bg-slate-700 transition-colors"
                    >
                      Use this template <span className="text-xs">→</span>
                    </button>
                    <button onClick={() => setEditingId(template.id)} className="p-2.5 bg-gray-100 text-gray-500 rounded-xl hover:bg-blue-50 hover:text-blue-500 transition-colors" title="Edit">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteTemplate(template.id)} className="p-2.5 bg-gray-100 text-gray-500 rounded-xl hover:bg-red-50 hover:text-red-500 transition-colors" title="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>);
            })}
            </div>
          )}
        </div>
        </>}
      </div>

      {/* Page Preview Modal — Desktop + Mobile side by side */}
      {pagePreview?.isOpen && (
        <div className="fixed inset-0 bg-black/85 flex flex-col z-50" onClick={() => setPagePreview(null)}>
          <div className="px-6 py-4 flex items-center justify-between bg-gray-900 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <Eye className="w-6 h-6 text-white" />
              <div>
                <h2 className="text-lg font-bold text-white">{pagePreview.name}</h2>
                <p className="text-gray-400 text-sm truncate max-w-xl">{pagePreview.url}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <a href={pagePreview.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
                <ExternalLink className="w-4 h-4" /> Open in new tab
              </a>
              <button onClick={() => setPagePreview(null)} className="text-white/80 hover:text-white text-3xl font-bold px-2">×</button>
            </div>
          </div>
          <div className="flex-1 flex gap-6 p-6 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {previewLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                  <p className="text-white text-lg font-medium">Loading page...</p>
                  <p className="text-gray-400 text-sm mt-1">{pagePreview.url}</p>
                </div>
              </div>
            ) : previewHtml ? (<>
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center gap-2 mb-3">
                  <Monitor className="w-4 h-4 text-blue-400" />
                  <span className="text-blue-400 text-sm font-semibold">Desktop</span>
                </div>
                <div className="flex-1 bg-white rounded-xl overflow-hidden shadow-2xl">
                  <iframe srcDoc={previewHtml} className="w-full h-full border-0" title="Desktop Preview" sandbox="allow-same-origin allow-scripts" />
                </div>
              </div>
              <div className="flex flex-col items-center" style={{ width: '375px', flexShrink: 0 }}>
                <div className="flex items-center gap-2 mb-3">
                  <Smartphone className="w-4 h-4 text-green-400" />
                  <span className="text-green-400 text-sm font-semibold">Mobile</span>
                </div>
                <div className="w-[375px] h-full bg-white rounded-[32px] overflow-hidden shadow-2xl border-[6px] border-gray-700">
                  <iframe srcDoc={previewHtml} className="w-full h-full border-0" title="Mobile Preview" sandbox="allow-same-origin allow-scripts" />
                </div>
              </div>
            </>) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-white text-lg font-medium">Could not load page</p>
                  <p className="text-gray-400 text-sm mt-2">Try opening it directly:</p>
                  <a href={pagePreview.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm mt-1 inline-block">{pagePreview.url}</a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fullscreen Preview Modal */}
      {fullscreenPreview.isOpen && (
        <div className="fixed inset-0 bg-black/80 flex flex-col z-50">
          {/* Modal Header */}
          <div className={`px-6 py-4 flex items-center justify-between ${
            activeTab === 'standard' ? 'bg-gray-900' : 'bg-purple-900'
          }`}>
            <div className="flex items-center gap-3">
              <Eye className="w-6 h-6 text-white" />
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-white">{fullscreenPreview.name}</h2>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                    fullscreenPreview.viewFormat === 'mobile' 
                      ? 'bg-green-500/20 text-green-300' 
                      : 'bg-blue-500/20 text-blue-300'
                  }`}>
                    {fullscreenPreview.viewFormat === 'mobile' ? (
                      <><Smartphone className="w-3 h-3" /> Mobile</>
                    ) : (
                      <><Monitor className="w-3 h-3" /> Desktop</>
                    )}
                  </span>
                </div>
                <p className="text-gray-400 text-sm truncate max-w-xl">{fullscreenPreview.url}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={fullscreenPreview.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg ${
                  activeTab === 'standard' 
                    ? 'bg-blue-600 hover:bg-blue-700' 
                    : 'bg-purple-600 hover:bg-purple-700'
                }`}
              >
                <ExternalLink className="w-4 h-4" />
                Open in new tab
              </a>
              <button
                onClick={() => setFullscreenPreview({ isOpen: false, url: '', name: '', viewFormat: 'desktop' })}
                className="text-white/80 hover:text-white text-3xl font-bold px-2"
              >
                ×
              </button>
            </div>
          </div>

          {/* Iframe */}
          <div className={`flex-1 flex items-center justify-center ${
            fullscreenPreview.viewFormat === 'mobile' ? 'bg-gray-800' : 'bg-white'
          }`}>
            <iframe
              src={fullscreenPreview.url}
              className={`bg-white ${
                fullscreenPreview.viewFormat === 'mobile' 
                  ? 'w-[375px] h-[812px] rounded-[40px] shadow-2xl border-8 border-gray-900' 
                  : 'w-full h-full'
              }`}
              sandbox="allow-same-origin allow-scripts"
              title={`Fullscreen Preview: ${fullscreenPreview.name}`}
            />
          </div>
        </div>
      )}
      {/* Floating Action Bars — single fixed container to avoid overlap */}
      {(selectedPages.length > 0 || (mainView === 'byType' && stagedImports.length > 0)) && (
        <div className="fixed bottom-0 left-0 right-0 z-40">
          <div className="max-w-5xl mx-auto px-6 pb-5 flex flex-col gap-3">
            {/* Selection bar */}
            {selectedPages.length > 0 && (
              <div className="bg-gray-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <CheckSquare className="w-5 h-5 text-green-400" />
                  <span className="font-semibold">{selectedPages.length}</span>
                  <span className="text-gray-300 text-sm">{selectedPages.length === 1 ? 'page selected' : 'pages selected'}</span>
                </div>

                <div className="h-6 w-px bg-gray-700" />

                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-gray-400" />
                  <select
                    value={selectedProductId}
                    onChange={(e) => setSelectedProductId(e.target.value)}
                    className="bg-gray-800 text-white border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none min-w-[180px]"
                  >
                    <option value="">Select product...</option>
                    {(products || []).map((prod) => (
                      <option key={prod.id} value={prod.id}>{prod.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex-1" />

                <button
                  onClick={() => setSelectedPages([])}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Deselect
                </button>

                {mainView === 'byType' ? (
                  <button
                    onClick={handleStagePages}
                    disabled={!selectedProductId}
                    className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add to list
                  </button>
                ) : (
                  <button
                    onClick={handleImportToFunnel}
                    disabled={!selectedProductId || isImporting}
                    className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
                  >
                    {isImporting ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" /></svg>
                        Importing...
                      </>
                    ) : (
                      <>Import to Funnel &rarr;</>
                    )}
                  </button>
                )}
              </div>
            )}

            {/* Staged imports bar — only in By Type */}
            {mainView === 'byType' && stagedImports.length > 0 && (
              <div className="bg-indigo-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-indigo-300" />
                  <span className="font-semibold">{stagedImports.length}</span>
                  <span className="text-indigo-200 text-sm">{stagedImports.length === 1 ? 'page ready' : 'pages ready'}</span>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {Object.entries(
                    stagedImports.reduce<Record<string, { count: number; productName: string }>>((acc, s) => {
                      const key = `${s.page_type}::${s.productId}`;
                      if (!acc[key]) acc[key] = { count: 0, productName: s.productName };
                      acc[key].count++;
                      return acc;
                    }, {})
                  ).map(([key, { count, productName }]) => {
                    const pageType = key.split('::')[0];
                    return (
                      <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-700/50 rounded-full text-xs text-indigo-100">
                        {getPageTypeLabel(pageType)} ({count}) &rarr; {productName}
                      </span>
                    );
                  })}
                </div>

                <div className="flex-1" />

                <button
                  onClick={() => setStagedImports([])}
                  className="px-3 py-1.5 text-sm text-indigo-300 hover:text-white transition-colors"
                >
                  Clear list
                </button>

                <button
                  onClick={handleImportStaged}
                  disabled={isImporting}
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
                >
                  {isImporting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75" /></svg>
                      Importing...
                    </>
                  ) : (
                    <>Import to Funnel &rarr;</>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
