'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { BUILT_IN_PAGE_TYPE_OPTIONS, PageType } from '@/types';
import type { ArchivedFunnel } from '@/types/database';
import { Plus, Trash2, Edit2, Save, X, Package, Tag, Link, MousePointer, ChevronDown, ChevronRight, DollarSign, Image as ImageIcon, MessageCircle, Send, Loader2, Sparkles, ExternalLink, Globe, Layers, CheckSquare, Square, FileText, RefreshCw, Upload, FileSpreadsheet, Search, AlertCircle, CheckCircle, MapPin, BarChart3 } from 'lucide-react';

interface NewProductForm {
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  benefits: string[];
  ctaText: string;
  ctaUrl: string;
  brandName: string;
}

const emptyForm: NewProductForm = {
  name: '',
  description: '',
  price: 0,
  imageUrl: '',
  benefits: [''],
  ctaText: 'Buy Now',
  ctaUrl: '',
  brandName: '',
};

export default function ProductsPage() {
  const router = useRouter();
  const { products, addProduct, updateProduct, deleteProduct, archivedFunnels, archivedFunnelsLoaded, loadArchivedFunnels, templates, funnelPages, addFunnelPage } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProduct, setNewProduct] = useState<NewProductForm>(emptyForm);
  const [benefitInput, setBenefitInput] = useState('');
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<Record<string, { role: string; content: string }[]>>({});
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [activeChatProductId, setActiveChatProductId] = useState<string | null>(null);

  // Swipe Library state
  const [swipeMode, setSwipeMode] = useState<'funnel' | 'type'>('funnel');
  const [selectedFunnelId, setSelectedFunnelId] = useState('');
  const [selectedTypeValue, setSelectedTypeValue] = useState('');
  const [selectedSwipePages, setSelectedSwipePages] = useState<{ name: string; page_type: string; url_to_swipe: string; prompt: string }[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  // Product Brief state (persisted in localStorage)
  const [productBriefs, setProductBriefs] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem('product_briefs') || '{}'); } catch { return {}; }
  });
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [briefExpanded, setBriefExpanded] = useState<Set<string>>(new Set());

  // Catalog import state
  const [showCatalogImport, setShowCatalogImport] = useState(false);
  const [catalogFileName, setCatalogFileName] = useState('');
  const [parsedCatalogRows, setParsedCatalogRows] = useState<Record<string, string>[]>([]);
  const [catalogEnrichStatus, setCatalogEnrichStatus] = useState<Record<number, 'pending' | 'enriching' | 'done' | 'error'>>({});
  const [catalogEnrichedData, setCatalogEnrichedData] = useState<Record<number, Record<string, unknown>>>({});
  const [catalogEnrichErrors, setCatalogEnrichErrors] = useState<Record<number, string>>({});
  const [isCatalogEnriching, setIsCatalogEnriching] = useState(false);
  const [catalogImportDone, setCatalogImportDone] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const saveProductBriefs = (briefs: Record<string, string>) => {
    setProductBriefs(briefs);
    try { localStorage.setItem('product_briefs', JSON.stringify(briefs)); } catch { /* ignore */ }
    fetch('/api/briefs-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefs }),
    }).catch(() => {});
  };

  const generateBrief = async (product: { id: string; name: string; description: string; price: number; brandName: string; benefits: string[]; ctaText: string; ctaUrl: string }) => {
    setBriefLoading(product.id);
    try {
      const res = await fetch('/api/product-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const updated = { ...productBriefs, [product.id]: data.brief };
      saveProductBriefs(updated);
      setBriefExpanded(prev => new Set(prev).add(product.id));
    } catch (error) {
      console.error('Brief generation error:', error);
    } finally {
      setBriefLoading(null);
    }
  };

  const detectNameColumn = (rows: Record<string, string>[]): string | null => {
    if (rows.length === 0) return null;
    const keys = Object.keys(rows[0]);
    const namePatterns = ['name', 'nome', 'product', 'prodotto', 'product_name', 'nome_prodotto', 'product name', 'nome prodotto', 'item', 'title', 'titolo', 'articolo'];
    for (const pattern of namePatterns) {
      const found = keys.find(k => k.toLowerCase().trim() === pattern);
      if (found) return found;
    }
    return keys[0] || null;
  };

  const processCatalogFile = async (file: File) => {
    setCatalogFileName(file.name);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, string>[];
    setParsedCatalogRows(rows);
    const status: Record<number, 'pending'> = {};
    rows.forEach((_, i) => { status[i] = 'pending'; });
    setCatalogEnrichStatus(status);
    setCatalogEnrichedData({});
    setCatalogEnrichErrors({});
    setCatalogImportDone(false);
  };

  const handleCatalogFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processCatalogFile(file);
  };

  const handleCatalogDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) await processCatalogFile(file);
  };

  const handleCatalogEnrich = async () => {
    if (parsedCatalogRows.length === 0) return;
    setIsCatalogEnriching(true);
    setCatalogImportDone(false);
    const nameCol = detectNameColumn(parsedCatalogRows);

    for (let i = 0; i < parsedCatalogRows.length; i++) {
      const row = parsedCatalogRows[i];
      const productName = nameCol ? String(row[nameCol] || '').trim() : '';

      if (!productName) {
        setCatalogEnrichStatus(prev => ({ ...prev, [i]: 'error' }));
        setCatalogEnrichErrors(prev => ({ ...prev, [i]: 'No product name found in row' }));
        continue;
      }

      setCatalogEnrichStatus(prev => ({ ...prev, [i]: 'enriching' }));

      try {
        const rawData: Record<string, string> = {};
        for (const [key, val] of Object.entries(row)) {
          if (key !== nameCol && String(val).trim()) rawData[key] = String(val);
        }

        const res = await fetch('/api/catalog-import/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productName, rawData }),
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const enriched = data.product;

        await addProduct({
          name: enriched.name || productName,
          description: enriched.description || '',
          price: enriched.price || 0,
          imageUrl: enriched.imageUrl || '',
          benefits: enriched.benefits || [],
          ctaText: enriched.ctaText || 'Buy Now',
          ctaUrl: enriched.ctaUrl || '',
          brandName: enriched.brandName || '',
          sku: enriched.sku || '',
          category: enriched.category || '',
          characteristics: enriched.characteristics || [],
          geoMarket: enriched.geoMarket || '',
        });

        setCatalogEnrichStatus(prev => ({ ...prev, [i]: 'done' }));
        setCatalogEnrichedData(prev => ({ ...prev, [i]: enriched }));
      } catch (error) {
        setCatalogEnrichStatus(prev => ({ ...prev, [i]: 'error' }));
        setCatalogEnrichErrors(prev => ({ ...prev, [i]: error instanceof Error ? error.message : 'Unknown error' }));
      }
    }

    setIsCatalogEnriching(false);
    setCatalogImportDone(true);
  };

  const resetCatalogImport = () => {
    setShowCatalogImport(false);
    setCatalogFileName('');
    setParsedCatalogRows([]);
    setCatalogEnrichStatus({});
    setCatalogEnrichedData({});
    setCatalogEnrichErrors({});
    setIsCatalogEnriching(false);
    setCatalogImportDone(false);
  };

  useEffect(() => {
    if (!archivedFunnelsLoaded) loadArchivedFunnels();
  }, [archivedFunnelsLoaded, loadArchivedFunnels]);

  useEffect(() => {
    if (Object.keys(productBriefs).length > 0) {
      fetch('/api/briefs-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefs: productBriefs }),
      }).catch(() => {});
    }
  }, []);

  const getPageTypeLabel = (value: string): string => {
    const opt = BUILT_IN_PAGE_TYPE_OPTIONS.find(o => o.value === value);
    return opt?.label || value.charAt(0).toUpperCase() + value.slice(1);
  };

  const pagesByType = useMemo(() => {
    const map: Record<string, { funnel_name: string; name: string; url_to_swipe: string; prompt: string; page_type: string }[]> = {};
    (archivedFunnels || []).forEach((f: ArchivedFunnel) => {
      const steps = (f.steps as { name: string; page_type: string; url_to_swipe: string; prompt: string }[]) || [];
      steps.forEach((s) => {
        const t = s.page_type || 'other';
        if (!map[t]) map[t] = [];
        map[t].push({ funnel_name: f.name, name: s.name, url_to_swipe: s.url_to_swipe, prompt: s.prompt || '', page_type: t });
      });
    });
    return map;
  }, [archivedFunnels]);

  const swipePageKey = (p: { name: string; url_to_swipe: string }) => `${p.name}::${p.url_to_swipe}`;

  const isSwipePageSelected = useCallback((p: { name: string; url_to_swipe: string }) => {
    const k = swipePageKey(p);
    return selectedSwipePages.some(sp => swipePageKey(sp) === k);
  }, [selectedSwipePages]);

  const toggleSwipePage = useCallback((page: { name: string; page_type: string; url_to_swipe: string; prompt: string }) => {
    setSelectedSwipePages(prev => {
      const k = swipePageKey(page);
      return prev.some(p => swipePageKey(p) === k)
        ? prev.filter(p => swipePageKey(p) !== k)
        : [...prev, page];
    });
  }, []);

  const visibleSwipePages = useMemo(() => {
    if (swipeMode === 'funnel' && selectedFunnelId) {
      const funnel = archivedFunnels.find(f => f.id === selectedFunnelId);
      if (!funnel) return [];
      return ((funnel.steps as { name: string; page_type: string; url_to_swipe: string; prompt: string }[]) || []);
    }
    if (swipeMode === 'type' && selectedTypeValue) {
      return pagesByType[selectedTypeValue] || [];
    }
    return [];
  }, [swipeMode, selectedFunnelId, selectedTypeValue, archivedFunnels, pagesByType]);

  const handleImportSwipePages = async (productId: string) => {
    if (selectedSwipePages.length === 0) return;
    setIsImporting(true);
    try {
      for (const page of selectedSwipePages) {
        await addFunnelPage({
          name: page.name,
          pageType: (page.page_type || 'landing') as PageType,
          productId,
          urlToSwipe: page.url_to_swipe,
          prompt: page.prompt || undefined,
          swipeStatus: 'pending',
          templateId: undefined,
          swipeResult: undefined,
          feedback: undefined,
        });
      }
      setSelectedSwipePages([]);
      router.push('/front-end-funnel');
    } catch (error) {
      console.error('Error importing pages:', error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleAddProduct = () => {
    if (!newProduct.name.trim()) return;
    addProduct({
      ...newProduct,
      benefits: newProduct.benefits.filter(b => b.trim() !== ''),
    });
    setNewProduct(emptyForm);
    setShowAddForm(false);
  };

  const addBenefit = () => {
    if (benefitInput.trim()) {
      setNewProduct({
        ...newProduct,
        benefits: [...newProduct.benefits.filter(b => b.trim() !== ''), benefitInput.trim()],
      });
      setBenefitInput('');
    }
  };

  const removeBenefit = (index: number) => {
    setNewProduct({
      ...newProduct,
      benefits: newProduct.benefits.filter((_, i) => i !== index),
    });
  };

  const toggleExpand = (productId: string) => {
    setExpandedProductId(prev => prev === productId ? null : productId);
  };

  const buildProductContext = useCallback((productId: string) => {
    const product = products.find(p => p.id === productId);
    if (!product) return '';

    const benefitsText = product.benefits?.length > 0
      ? product.benefits.map((b, i) => `  ${i + 1}. ${b}`).join('\n')
      : '  No benefits specified';

    const allProductsText = products.map(p => `- ${p.name} (${p.brandName}) — €${p.price}`).join('\n');

    const funnelsText = (archivedFunnels || []).map(f => {
      const steps = (f.steps as { name: string; page_type: string; product_name: string }[]) || [];
      const relevantSteps = steps.filter(s => s.product_name === product.name);
      const suffix = relevantSteps.length > 0 ? ` [USES THIS PRODUCT in ${relevantSteps.length} step(s)]` : '';
      return `- "${f.name}" (${f.total_steps} step)${suffix}`;
    }).join('\n');

    const templatesText = (templates || []).slice(0, 20).map(t => `- ${t.name} (${t.pageType})`).join('\n');

    const activeFunnelText = (funnelPages || []).map((p, i) => `  Step ${i + 1}: "${p.name}" (${p.pageType})`).join('\n');

    const briefText = productBriefs[productId] || '';

    return [
      `=== PRODUCT UNDER ANALYSIS ===`,
      `Name: ${product.name}`,
      `Brand: ${product.brandName}`,
      `Price: €${product.price}`,
      `Description: ${product.description}`,
      `Benefits:\n${benefitsText}`,
      `CTA: "${product.ctaText}" → ${product.ctaUrl || 'N/A'}`,
      product.sku ? `SKU: ${product.sku}` : '',
      product.category ? `Category: ${product.category}` : '',
      product.geoMarket ? `Geo Market: ${product.geoMarket}` : '',
      product.characteristics?.length ? `Characteristics:\n${product.characteristics.map((c: string, i: number) => `  ${i + 1}. ${c}`).join('\n')}` : '',
      product.imageUrl ? `Image: ${product.imageUrl}` : '',
      briefText ? `\n=== PRODUCT BRIEF (separate document, NOT the product card) ===\n${briefText}` : '',
      `\n=== ALL PRODUCTS ===\n${allProductsText}`,
      `\n=== SAVED FUNNELS IN ARCHIVE ===\n${funnelsText || 'None'}`,
      `\n=== AVAILABLE TEMPLATES ===\n${templatesText || 'None'}`,
      activeFunnelText ? `\n=== FRONT END FUNNEL (active steps) ===\n${activeFunnelText}` : '',
      `\n=== EDIT CAPABILITIES ===`,
      `IMPORTANT: There are TWO separate things you can edit:`,
      ``,
      `1) THE PRODUCT CARD — fields: name, description, brandName, price, benefits, ctaText, ctaUrl`,
      `   Use this when the user wants to change product info (name, description, price, benefits, CTA, brand).`,
      `   Format — put at the END of your message:`,
      '```__update_product__',
      `{"name":"...","description":"...","benefits":["..."],"price":49}`,
      '```',
      ``,
      `2) THE PRODUCT BRIEF — a separate research document (Target Market, Unique Mechanism, Hooks, Problem Narrative, etc.)`,
      `   Use this when the user mentions: brief, unique mechanism, hooks, target market, problem narrative, fascinations, metaphors, characterizations, ad angles, UMP, UMS, or any section from the Ecom Domination framework.`,
      `   Format — put at the END of your message:`,
      '```__update_brief__',
      `The COMPLETE updated brief goes here with ALL sections`,
      '```',
      ``,
      `RULES:`,
      `- NEVER confuse the two. If the user says "change the unique mechanism" → update the BRIEF, NOT the description.`,
      `- If the user says "change the description" → update the PRODUCT CARD.`,
      `- For product card: only include fields you want to change (partial update). benefits = array, price = number.`,
      `- For brief: you MUST output the COMPLETE brief with ALL sections. Copy unchanged sections as-is, update the requested ones. The block REPLACES the entire brief.`,
      `- CRITICAL: Always close the block with three backticks on their own line. Never leave it unclosed.`,
      `- Always explain what you changed BEFORE any update block.`,
      `- The update blocks are hidden from the user and applied automatically.`,
      `- You can include BOTH blocks in one message if the user wants to change both.`,
    ].filter(Boolean).join('\n');
  }, [products, archivedFunnels, templates, funnelPages, productBriefs]);

  const handleChatSend = async (productId: string) => {
    if (!chatInput.trim() || isChatLoading) return;
    const newMsg = { role: 'user' as const, content: chatInput.trim() };
    const msgs = [...(chatMessages[productId] || []), newMsg];
    setChatMessages(prev => ({ ...prev, [productId]: msgs }));
    setChatInput('');
    setIsChatLoading(true);
    try {
      const res = await fetch('/api/funnel-brief/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs,
          funnel_context: buildProductContext(productId),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      let reply = data.reply as string;
      const changes: string[] = [];

      // Handle product card updates (closed or unclosed block)
      const productMatch = reply.match(/```__update_product__\s*([\s\S]*?)(?:```|$)/);
      if (productMatch) {
        try {
          const updates = JSON.parse(productMatch[1].trim());
          const fieldMap: Record<string, string> = {
            name: 'name', description: 'description', brandName: 'brandName',
            price: 'price', benefits: 'benefits', ctaText: 'ctaText', ctaUrl: 'ctaUrl', imageUrl: 'imageUrl',
          };
          const mapped: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(updates)) {
            if (fieldMap[k]) mapped[fieldMap[k]] = v;
          }
          if (Object.keys(mapped).length > 0) {
            updateProduct(productId, mapped);
            changes.push('Product card updated');
          }
        } catch { /* ignore parse errors */ }
        reply = reply.replace(/```__update_product__\s*[\s\S]*?(?:```|$)/, '').trim();
      }

      // Handle brief updates (closed or unclosed block — brief can be very long)
      const briefIdx = reply.indexOf('```__update_brief__');
      if (briefIdx !== -1) {
        const afterTag = reply.substring(briefIdx + '```__update_brief__'.length);
        const closingIdx = afterTag.indexOf('```');
        const newBrief = (closingIdx !== -1 ? afterTag.substring(0, closingIdx) : afterTag).trim();
        if (newBrief) {
          const updated = { ...productBriefs, [productId]: newBrief };
          saveProductBriefs(updated);
          changes.push('Brief updated');
        }
        reply = reply.substring(0, briefIdx).trim();
      }

      if (changes.length > 0) {
        reply += `\n\n✅ ${changes.join(' + ')}!`;
      }

      setChatMessages(prev => ({ ...prev, [productId]: [...msgs, { role: 'assistant', content: reply }] }));
    } catch (error) {
      setChatMessages(prev => ({ ...prev, [productId]: [...msgs, { role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Unknown'}` }] }));
    } finally {
      setIsChatLoading(false);
    }
  };

  // Edit benefits for existing product
  const [editBenefitInput, setEditBenefitInput] = useState('');

  const addEditBenefit = (productId: string, currentBenefits: string[]) => {
    if (editBenefitInput.trim()) {
      updateProduct(productId, { benefits: [...currentBenefits, editBenefitInput.trim()] });
      setEditBenefitInput('');
    }
  };

  const removeEditBenefit = (productId: string, currentBenefits: string[], index: number) => {
    updateProduct(productId, { benefits: currentBenefits.filter((_, i) => i !== index) });
  };

  return (
    <div className="min-h-screen">
      <Header
        title="My Products"
        subtitle="Manage your products for the swipe funnel"
      />

      <div className="p-6 max-w-5xl mx-auto">
        {/* Toolbar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => { setShowAddForm(true); setShowCatalogImport(false); }}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Product
            </button>
            <button
              onClick={() => { setShowCatalogImport(true); setShowAddForm(false); }}
              className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors"
            >
              <Upload className="w-4 h-4" />
              Import Catalog
            </button>
            <span className="text-gray-500">
              {products.length} {products.length === 1 ? 'product' : 'products'}
            </span>
          </div>
        </div>

        {/* Add Product Form */}
        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Package className="w-5 h-5 text-blue-600" />
              New Product
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Name *</label>
                <input
                  type="text"
                  value={newProduct.name}
                  onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="Product name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Brand Name *</label>
                <input
                  type="text"
                  value={newProduct.brandName}
                  onChange={(e) => setNewProduct({ ...newProduct, brandName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="E.g.: YourBrand"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
                <textarea
                  value={newProduct.description}
                  onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  rows={3}
                  placeholder="Product description"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Benefits</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={benefitInput}
                    onChange={(e) => setBenefitInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addBenefit())}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    placeholder="Add a benefit..."
                  />
                  <button type="button" onClick={addBenefit} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {newProduct.benefits.filter(b => b.trim() !== '').map((benefit, index) => (
                    <span key={index} className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
                      {benefit}
                      <button onClick={() => removeBenefit(index)} className="hover:text-blue-600"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">CTA Text</label>
                <input
                  type="text"
                  value={newProduct.ctaText}
                  onChange={(e) => setNewProduct({ ...newProduct, ctaText: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="E.g.: Buy Now"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">URL CTA</label>
                <input
                  type="url"
                  value={newProduct.ctaUrl}
                  onChange={(e) => setNewProduct({ ...newProduct, ctaUrl: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="https://yoursite.com/buy"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Price</label>
                <input
                  type="number"
                  value={newProduct.price}
                  onChange={(e) => setNewProduct({ ...newProduct, price: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  step="0.01"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Image URL</label>
                <input
                  type="url"
                  value={newProduct.imageUrl}
                  onChange={(e) => setNewProduct({ ...newProduct, imageUrl: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder="https://..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowAddForm(false); setNewProduct(emptyForm); }} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button
                onClick={handleAddProduct}
                disabled={!newProduct.name.trim() || !newProduct.brandName.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Save Product
              </button>
            </div>
          </div>
        )}

        {/* Catalog Import Panel */}
        {showCatalogImport && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                Import Product Catalog
              </h3>
              <button onClick={resetCatalogImport} className="p-1 text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Step 1: File Upload */}
            {parsedCatalogRows.length === 0 && (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleCatalogDrop}
                className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${
                  isDragging ? 'border-emerald-400 bg-emerald-50' : 'border-gray-300 hover:border-emerald-400'
                }`}
              >
                <FileSpreadsheet className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-600 mb-2">Drag & drop your catalog file here, or click to select</p>
                <p className="text-sm text-gray-400 mb-4">Supports CSV, XLSX, XLS — needs at least a column with product names</p>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 cursor-pointer transition-colors">
                  <Upload className="w-4 h-4" />
                  Select File
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={handleCatalogFileSelect}
                    className="hidden"
                  />
                </label>
              </div>
            )}

            {/* Step 2: Preview */}
            {parsedCatalogRows.length > 0 && !isCatalogEnriching && !catalogImportDone && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">{catalogFileName}</span>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded-full font-medium">
                      {parsedCatalogRows.length} products found
                    </span>
                  </div>
                  <button
                    onClick={() => { setParsedCatalogRows([]); setCatalogFileName(''); }}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Change file
                  </button>
                </div>

                <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
                  <div className="max-h-[300px] overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 text-gray-600 font-medium">#</th>
                          {Object.keys(parsedCatalogRows[0] || {}).slice(0, 5).map(key => (
                            <th key={key} className="text-left px-3 py-2 text-gray-600 font-medium truncate max-w-[150px]">
                              {key}
                            </th>
                          ))}
                          {Object.keys(parsedCatalogRows[0] || {}).length > 5 && (
                            <th className="text-left px-3 py-2 text-gray-400 font-medium">...</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {parsedCatalogRows.slice(0, 50).map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                            {Object.values(row).slice(0, 5).map((val, j) => (
                              <td key={j} className="px-3 py-2 text-gray-800 truncate max-w-[150px]">
                                {String(val)}
                              </td>
                            ))}
                            {Object.keys(row).length > 5 && (
                              <td className="px-3 py-2 text-gray-400">...</td>
                            )}
                          </tr>
                        ))}
                        {parsedCatalogRows.length > 50 && (
                          <tr>
                            <td colSpan={99} className="px-3 py-2 text-center text-gray-400 text-xs">
                              ... and {parsedCatalogRows.length - 50} more rows
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-blue-50 rounded-lg p-3 mb-4 flex items-start gap-2">
                  <Search className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <strong>AI Web Research:</strong> For each product, AI will search the web to find descriptions, characteristics, ingredients/specs, benefits, pricing, target market, and suggest promotion angles.
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <button onClick={resetCatalogImport} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleCatalogEnrich}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Research & Import All ({parsedCatalogRows.length})
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Enriching / Done */}
            {(isCatalogEnriching || catalogImportDone) && (
              <div>
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700">
                      {catalogImportDone ? 'Import complete!' : 'Researching products online...'}
                    </span>
                    <span className="text-sm text-gray-500">
                      {Object.values(catalogEnrichStatus).filter(s => s === 'done').length} / {parsedCatalogRows.length}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                      style={{ width: `${(Object.values(catalogEnrichStatus).filter(s => s === 'done' || s === 'error').length / parsedCatalogRows.length) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="space-y-2 max-h-[400px] overflow-auto">
                  {parsedCatalogRows.map((row, i) => {
                    const nameCol = detectNameColumn(parsedCatalogRows);
                    const productName = nameCol ? String(row[nameCol] || '') : `Row ${i + 1}`;
                    const status = catalogEnrichStatus[i];
                    const enriched = catalogEnrichedData[i] as Record<string, unknown> | undefined;
                    const error = catalogEnrichErrors[i];

                    return (
                      <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${
                        status === 'done' ? 'bg-green-50 border-green-200' :
                        status === 'error' ? 'bg-red-50 border-red-200' :
                        status === 'enriching' ? 'bg-blue-50 border-blue-200' :
                        'bg-gray-50 border-gray-200'
                      }`}>
                        {status === 'enriching' && <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />}
                        {status === 'done' && <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />}
                        {status === 'error' && <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                        {status === 'pending' && <div className="w-4 h-4 rounded-full border-2 border-gray-300 flex-shrink-0" />}

                        <span className="text-sm font-medium text-gray-800 flex-1 truncate">{productName}</span>

                        {status === 'done' && enriched && (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {enriched.category && <span className="text-xs px-2 py-0.5 bg-teal-100 text-teal-700 rounded-full">{String(enriched.category)}</span>}
                            {enriched.geoMarket && <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">{String(enriched.geoMarket)}</span>}
                            <span className="text-xs text-green-600 font-bold">&euro;{String(enriched.price || 0)}</span>
                          </div>
                        )}

                        {status === 'error' && (
                          <span className="text-xs text-red-600 truncate max-w-[250px] flex-shrink-0">{error}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {catalogImportDone && (
                  <div className="flex justify-end mt-4">
                    <button
                      onClick={resetCatalogImport}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Done
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Products List */}
        <div className="space-y-3">
          {products.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
              <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900">No products</h3>
              <p className="text-gray-500 mt-1">Add your first product to get started</p>
            </div>
          ) : (
            products.map((product) => {
              const isExpanded = expandedProductId === product.id;
              const isEditing = editingId === product.id;
              return (
                <div key={product.id} className={`bg-white rounded-xl border overflow-hidden shadow-sm transition-all ${isExpanded ? 'border-blue-200 shadow-md' : 'border-gray-200 hover:shadow-md'}`}>
                  {/* Collapsed Header */}
                  <div
                    className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                    onClick={() => toggleExpand(product.id)}
                  >
                    {isExpanded ? <ChevronDown className="w-5 h-5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />}

                    {product.imageUrl ? (
                      <img src={product.imageUrl} alt={product.name} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-gray-200" />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center flex-shrink-0">
                        <Package className="w-5 h-5 text-blue-500" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-gray-900 text-base">{product.name}</span>
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full font-medium">{product.brandName || 'No Brand'}</span>
                        {product.category && <span className="px-2 py-0.5 bg-teal-100 text-teal-700 text-xs rounded-full font-medium">{product.category}</span>}
                      </div>
                      <p className="text-sm text-gray-500 truncate mt-0.5">{product.description || 'No description'}</p>
                    </div>

                    <span className="text-lg font-bold text-green-600 flex-shrink-0">&euro;{product.price.toFixed(2)}</span>

                    <div className="flex gap-1 ml-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setEditingId(isEditing ? null : product.id)}
                        className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${product.name}"?`)) deleteProduct(product.id); }}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t border-gray-100">
                      {/* Edit Form */}
                      {isEditing ? (
                        <div className="p-6 bg-blue-50/30 space-y-4">
                          <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                            <Edit2 className="w-4 h-4 text-blue-600" />
                            Edit Product
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                              <input type="text" value={product.name} onChange={(e) => updateProduct(product.id, { name: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Brand</label>
                              <input type="text" value={product.brandName} onChange={(e) => updateProduct(product.id, { brandName: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" />
                            </div>
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                              <textarea value={product.description} onChange={(e) => updateProduct(product.id, { description: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" rows={3} />
                            </div>
                            <div className="md:col-span-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">Benefits</label>
                              <div className="flex gap-2 mb-2">
                                <input type="text" value={editBenefitInput} onChange={(e) => setEditBenefitInput(e.target.value)}
                                  onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addEditBenefit(product.id, product.benefits || []))}
                                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" placeholder="Add benefit..." />
                                <button onClick={() => addEditBenefit(product.id, product.benefits || [])} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
                                  <Plus className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {(product.benefits || []).map((b, i) => (
                                  <span key={i} className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
                                    {b}
                                    <button onClick={() => removeEditBenefit(product.id, product.benefits, i)} className="hover:text-blue-600"><X className="w-3 h-3" /></button>
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">CTA Text</label>
                              <input type="text" value={product.ctaText} onChange={(e) => updateProduct(product.id, { ctaText: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">URL CTA</label>
                              <input type="url" value={product.ctaUrl} onChange={(e) => updateProduct(product.id, { ctaUrl: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Price</label>
                              <input type="number" value={product.price} onChange={(e) => updateProduct(product.id, { price: parseFloat(e.target.value) || 0 })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" step="0.01" />
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Image URL</label>
                              <input type="url" value={product.imageUrl || ''} onChange={(e) => updateProduct(product.id, { imageUrl: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white" placeholder="https://..." />
                            </div>
                          </div>
                          <div className="flex justify-end pt-2">
                            <button onClick={() => setEditingId(null)} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                              <Save className="w-4 h-4" />
                              Close Editor
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Product Details View */
                        <div className="p-6 space-y-6">
                          {/* Top section: Image + Details side by side */}
                          <div className="flex gap-8">
                            {/* Product Image */}
                            <div className="flex-shrink-0">
                              {product.imageUrl ? (
                                <img
                                  src={product.imageUrl}
                                  alt={product.name}
                                  className="w-48 h-48 rounded-xl object-cover border border-gray-200 shadow-sm"
                                />
                              ) : (
                                <div className="w-48 h-48 rounded-xl bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 flex flex-col items-center justify-center text-gray-400">
                                  <ImageIcon className="w-12 h-12 mb-2" />
                                  <span className="text-xs">No image</span>
                                </div>
                              )}
                            </div>

                            {/* Product Info */}
                            <div className="flex-1 min-w-0 space-y-4">
                              {/* Title + Price */}
                              <div>
                                <div className="flex items-center gap-3 flex-wrap mb-1">
                                  <h3 className="text-2xl font-bold text-gray-900">{product.name}</h3>
                                  <span className="px-3 py-1 bg-purple-100 text-purple-700 text-sm rounded-full font-medium">{product.brandName}</span>
                                  {product.sku && <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full font-mono">SKU: {product.sku}</span>}
                                  {product.category && <span className="px-2 py-0.5 bg-teal-100 text-teal-700 text-xs rounded-full font-medium">{product.category}</span>}
                                  {product.geoMarket && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full font-medium flex items-center gap-1"><MapPin className="w-3 h-3" />{product.geoMarket}</span>}
                                </div>
                                <div className="flex items-center gap-2 text-2xl font-bold text-green-600">
                                  <DollarSign className="w-5 h-5" />
                                  &euro;{product.price.toFixed(2)}
                                </div>
                              </div>

                              {/* Description */}
                              <div>
                                <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</h4>
                                <p className="text-gray-700 leading-relaxed">{product.description || 'No description'}</p>
                              </div>

                              {/* CTA */}
                              <div className="flex items-center gap-4">
                                <div className="flex items-center gap-2 text-sm">
                                  <MousePointer className="w-4 h-4 text-blue-500" />
                                  <span className="text-gray-600">CTA:</span>
                                  <span className="font-semibold text-gray-900">{product.ctaText || 'Not set'}</span>
                                </div>
                                {product.ctaUrl && (
                                  <a href={product.ctaUrl} target="_blank" rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 transition-colors">
                                    <Globe className="w-3.5 h-3.5" />
                                    <span className="truncate max-w-[200px]">{product.ctaUrl}</span>
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Benefits */}
                          <div className="bg-blue-50/50 rounded-xl p-5 border border-blue-100">
                            <h4 className="text-sm font-semibold text-blue-800 uppercase tracking-wide mb-3 flex items-center gap-2">
                              <Tag className="w-4 h-4" />
                              Product Benefits
                            </h4>
                            {product.benefits?.length > 0 ? (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {product.benefits.map((benefit, index) => (
                                  <div key={index} className="flex items-start gap-2 text-sm text-gray-700">
                                    <span className="w-5 h-5 rounded-full bg-blue-200 text-blue-800 flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5">{index + 1}</span>
                                    <span>{benefit}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-gray-400 text-sm">No benefits added. Click Edit to add some.</p>
                            )}
                          </div>

                          {/* Characteristics */}
                          {product.characteristics && product.characteristics.length > 0 && (
                            <div className="bg-slate-50/50 rounded-xl p-5 border border-slate-200">
                              <h4 className="text-sm font-semibold text-slate-800 uppercase tracking-wide mb-3 flex items-center gap-2">
                                <BarChart3 className="w-4 h-4" />
                                Characteristics
                              </h4>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {product.characteristics.map((char: string, index: number) => (
                                  <div key={index} className="flex items-start gap-2 text-sm text-gray-700">
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 mt-2 flex-shrink-0" />
                                    <span>{char}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Product Brief Section */}
                          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                            <div
                              className="px-5 py-3 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-gray-200 flex items-center justify-between cursor-pointer hover:from-amber-100 hover:to-orange-100 transition-colors"
                              onClick={() => setBriefExpanded(prev => {
                                const n = new Set(prev);
                                n.has(product.id) ? n.delete(product.id) : n.add(product.id);
                                return n;
                              })}
                            >
                              <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-amber-600" />
                                <span className="font-semibold text-sm text-gray-900">Product Brief</span>
                                {productBriefs[product.id] && <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">Generated</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                {productBriefs[product.id] && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); generateBrief(product); }}
                                    disabled={briefLoading === product.id}
                                    className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded-md transition-colors disabled:opacity-50"
                                    title="Regenerate"
                                  >
                                    {briefLoading === product.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                  </button>
                                )}
                                {briefExpanded.has(product.id) ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                              </div>
                            </div>
                            {briefExpanded.has(product.id) && (
                              <div className="p-5">
                                {!productBriefs[product.id] && briefLoading !== product.id && (
                                  <div className="text-center py-6">
                                    <FileText className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                                    <p className="text-sm text-gray-400 mb-4">Generate an AI-powered product research brief<br/>based on the Ecom Domination framework</p>
                                    <button
                                      onClick={() => generateBrief(product)}
                                      className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 transition-colors"
                                    >
                                      <Sparkles className="w-4 h-4" />
                                      Generate Brief
                                    </button>
                                  </div>
                                )}
                                {briefLoading === product.id && (
                                  <div className="text-center py-8">
                                    <Loader2 className="w-8 h-8 text-amber-500 animate-spin mx-auto mb-3" />
                                    <p className="text-sm text-gray-500">Generating product brief...</p>
                                    <p className="text-xs text-gray-400 mt-1">This may take 30-60 seconds</p>
                                  </div>
                                )}
                                {productBriefs[product.id] && briefLoading !== product.id && (
                                  <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap text-[13px] leading-relaxed">
                                    {productBriefs[product.id]}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Swipe Library Section */}
                          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                            <div className="px-5 py-3 bg-gradient-to-r from-emerald-50 to-teal-50 border-b border-gray-200 flex items-center gap-2">
                              <Layers className="w-4 h-4 text-emerald-600" />
                              <span className="font-semibold text-sm text-gray-900">Import to Front End Funnel</span>
                            </div>

                            <div className="p-4 space-y-3">
                              {/* Row 1: Mode selector + Dropdown */}
                              <div className="flex gap-3">
                                <select
                                  value={swipeMode}
                                  onChange={(e) => { setSwipeMode(e.target.value as 'funnel' | 'type'); setSelectedSwipePages([]); setSelectedFunnelId(''); setSelectedTypeValue(''); }}
                                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none bg-white"
                                >
                                  <option value="funnel">By Funnel</option>
                                  <option value="type">By Type</option>
                                </select>

                                {swipeMode === 'funnel' ? (
                                  <select
                                    value={selectedFunnelId}
                                    onChange={(e) => { setSelectedFunnelId(e.target.value); setSelectedSwipePages([]); }}
                                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none bg-white"
                                  >
                                    <option value="">-- Select a funnel --</option>
                                    {archivedFunnels.map(f => (
                                      <option key={f.id} value={f.id}>{f.name} ({f.total_steps} pages)</option>
                                    ))}
                                  </select>
                                ) : (
                                  <select
                                    value={selectedTypeValue}
                                    onChange={(e) => { setSelectedTypeValue(e.target.value); setSelectedSwipePages([]); }}
                                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none bg-white"
                                  >
                                    <option value="">-- Select a page type --</option>
                                    {Object.entries(pagesByType).sort(([a], [b]) => a.localeCompare(b)).map(([tv, pages]) => (
                                      <option key={tv} value={tv}>{getPageTypeLabel(tv)} ({pages.length})</option>
                                    ))}
                                  </select>
                                )}
                              </div>

                              {/* Pages list */}
                              {visibleSwipePages.length > 0 && (
                                <div className="border border-gray-200 rounded-lg overflow-hidden">
                                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                                    <span className="text-xs font-medium text-gray-500">{visibleSwipePages.length} pages</span>
                                    <button
                                      onClick={() => {
                                        const allSel = visibleSwipePages.every(p => isSwipePageSelected(p));
                                        if (allSel) {
                                          setSelectedSwipePages([]);
                                        } else {
                                          setSelectedSwipePages([...visibleSwipePages]);
                                        }
                                      }}
                                      className="text-xs text-emerald-600 hover:text-emerald-800 font-medium"
                                    >
                                      {visibleSwipePages.every(p => isSwipePageSelected(p)) ? 'Deselect all' : 'Select all'}
                                    </button>
                                  </div>
                                  <div className="max-h-[200px] overflow-y-auto divide-y divide-gray-100">
                                    {visibleSwipePages.map((page, pi) => (
                                      <div
                                        key={pi}
                                        onClick={() => toggleSwipePage(page)}
                                        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors"
                                      >
                                        {isSwipePageSelected(page)
                                          ? <CheckSquare className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                          : <Square className="w-4 h-4 text-gray-300 flex-shrink-0" />
                                        }
                                        <span className="text-sm text-gray-800 truncate flex-1">{page.name}</span>
                                        <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full flex-shrink-0">{getPageTypeLabel(page.page_type)}</span>
                                        {page.url_to_swipe && (
                                          <a href={page.url_to_swipe} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-500 hover:text-blue-700 flex-shrink-0">
                                            <ExternalLink className="w-3 h-3" />
                                          </a>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Import button */}
                              {selectedSwipePages.length > 0 && (
                                <div className="flex justify-end">
                                  <button
                                    onClick={() => handleImportSwipePages(product.id)}
                                    disabled={isImporting}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                                  >
                                    {isImporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                                    Import ({selectedSwipePages.length})
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* AI Chat Section */}
                          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                            <div className="px-5 py-3 bg-gradient-to-r from-indigo-50 to-purple-50 border-b border-gray-200 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-indigo-600" />
                              <span className="font-semibold text-sm text-gray-900">AI Strategy Chat</span>
                              <span className="text-xs text-gray-400 ml-1">Strategize with AI on how to promote this product</span>
                            </div>

                            <div className="max-h-[450px] overflow-y-auto p-4 space-y-3">
                              {(!chatMessages[product.id] || chatMessages[product.id].length === 0) && (
                                <div className="text-center py-8">
                                  <MessageCircle className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                                  <p className="text-sm text-gray-400 mb-3">Ask AI how to promote this product...</p>
                                  <div className="flex flex-wrap justify-center gap-2">
                                    {[
                                      'Which funnel is best for this product?',
                                      'Suggest a launch strategy',
                                      'What colors and style for the landing pages?',
                                      'How to structure the copy for this product?',
                                    ].map((suggestion, i) => (
                                      <button
                                        key={i}
                                        onClick={() => { setActiveChatProductId(product.id); setChatInput(suggestion); }}
                                        className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-full hover:bg-indigo-100 hover:text-indigo-700 transition-colors"
                                      >
                                        {suggestion}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {(chatMessages[product.id] || []).map((msg, mi) => (
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
                              {isChatLoading && activeChatProductId === product.id && (
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
                                value={activeChatProductId === product.id ? chatInput : ''}
                                onChange={(e) => { setActiveChatProductId(product.id); setChatInput(e.target.value); }}
                                onFocus={() => setActiveChatProductId(product.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(product.id); } }}
                                placeholder="How can I promote this product?"
                                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                                disabled={isChatLoading}
                              />
                              <button
                                onClick={() => handleChatSend(product.id)}
                                disabled={isChatLoading || !(activeChatProductId === product.id && chatInput.trim())}
                                className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                <Send className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
