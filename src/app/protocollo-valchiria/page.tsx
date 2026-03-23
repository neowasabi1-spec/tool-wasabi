'use client';

import { useState, useEffect, useRef } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { Swords, ChevronDown, Package, Check, Wand2, Eye, ChevronRight } from 'lucide-react';

interface Flow {
  id: string;
  name: string;
  pages: { id: string; name: string; pageType: string; url: string }[];
  productId: string;
  productName: string;
}

export default function ProtocolloValchiriaPage() {
  const { funnelPages, products, isInitialized, initialize } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedFlow, setExpandedFlow] = useState<string | null>(null);
  const [swipeTarget, setSwipeTarget] = useState<string | null>(null);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [targetProductId, setTargetProductId] = useState<string | null>(null);
  const [showTargetPicker, setShowTargetPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setSwipeTarget(null);
        setShowProductPicker(false);
      }
      if (targetRef.current && !targetRef.current.contains(e.target as Node)) {
        setShowTargetPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Group pages into flows by common prefix (before " — ")
  const flows: Flow[] = (() => {
    const groups = new Map<string, Flow>();

    funnelPages.forEach((page) => {
      const parts = page.name.split(' — ');
      const flowName = parts[0]?.trim() || page.name;
      const key = `${flowName}__${page.productId}`;

      if (!groups.has(key)) {
        const product = products.find(p => p.id === page.productId);
        groups.set(key, {
          id: key,
          name: flowName,
          pages: [],
          productId: page.productId,
          productName: product?.name || 'No product',
        });
      }

      groups.get(key)!.pages.push({
        id: page.id,
        name: page.name,
        pageType: page.pageType,
        url: page.urlToSwipe || '',
      });
    });

    return Array.from(groups.values());
  })();

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === flows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(flows.map(f => f.id)));
    }
  };

  const handleSwipe = (flowId: string, productId: string) => {
    const product = products.find(p => p.id === productId);
    const flow = flows.find(f => f.id === flowId);
    if (!product || !flow) return;

    alert(`Swipe "${flow.name}" (${flow.pages.length} pages) → ${product.name}\n\nFunzionalità di swipe in arrivo!`);
    setSwipeTarget(null);
    setShowProductPicker(false);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-600 to-red-600 rounded-xl shadow-lg">
              <Swords className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Protocollo Valchiria</h1>
              <p className="text-gray-500 text-sm">Seleziona un flusso e swippalo per il tuo prodotto</p>
            </div>
          </div>
          {selected.size > 0 && (
            <div className="bg-purple-50 border border-purple-200 rounded-lg px-4 py-2">
              <span className="text-purple-700 text-sm font-semibold">{selected.size} flussi selezionati</span>
            </div>
          )}
        </div>

        {/* Target product selector */}
        <div className="mb-6 flex items-center gap-4">
          <div className="relative" ref={targetRef}>
            <button
              onClick={() => setShowTargetPicker(!showTargetPicker)}
              className={`inline-flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold border-2 transition-all ${
                targetProductId
                  ? 'bg-green-50 border-green-400 text-green-800 shadow-sm'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-purple-300'
              }`}
            >
              <Package className="w-5 h-5" />
              {targetProductId ? products.find(p => p.id === targetProductId)?.name || 'Prodotto' : 'Seleziona Prodotto Target'}
              <ChevronDown className={`w-4 h-4 transition-transform ${showTargetPicker ? 'rotate-180' : ''}`} />
            </button>

            {showTargetPicker && (
              <div className="absolute top-full left-0 mt-2 w-80 bg-white rounded-xl border border-gray-200 shadow-2xl z-50 max-h-72 overflow-y-auto">
                <div className="px-4 py-2.5 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Per quale prodotto vuoi swippare?</p>
                </div>
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setTargetProductId(p.id); setShowTargetPicker(false); }}
                    className={`w-full text-left px-4 py-3 text-sm hover:bg-purple-50 flex items-center justify-between transition-colors ${
                      targetProductId === p.id ? 'bg-purple-50 text-purple-700' : 'text-gray-700'
                    }`}
                  >
                    <div>
                      <p className="font-medium">{p.name}</p>
                      {p.price > 0 && <p className="text-xs text-gray-400 mt-0.5">€{p.price}</p>}
                    </div>
                    {targetProductId === p.id && <Check className="w-4 h-4 text-purple-600" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {targetProductId && selected.size > 0 && (
            <button
              onClick={() => {
                const product = products.find(p => p.id === targetProductId);
                const selectedFlows = flows.filter(f => selected.has(f.id));
                alert(`Swipe ${selectedFlows.length} flussi → ${product?.name}\n\n${selectedFlows.map(f => f.name).join('\n')}\n\nFunzionalità in arrivo!`);
              }}
              className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-purple-600 to-red-600 text-white rounded-xl text-sm font-semibold hover:from-purple-700 hover:to-red-700 transition-all shadow-md"
            >
              <Wand2 className="w-4 h-4" />
              Swipe {selected.size} flussi per {products.find(p => p.id === targetProductId)?.name}
            </button>
          )}
        </div>

        {/* Flows */}
        <div className="space-y-3">
          {flows.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
              <Swords className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">Nessun flusso disponibile</p>
              <p className="text-gray-400 text-sm mt-1">Aggiungi pagine in Front End Funnel per creare flussi</p>
            </div>
          ) : (
            flows.map((flow, index) => {
              const isSelected = selected.has(flow.id);
              const isExpanded = expandedFlow === flow.id;
              const isSwipeOpen = swipeTarget === flow.id;

              return (
                <div
                  key={flow.id}
                  className={`bg-white rounded-xl border shadow-sm transition-all ${
                    isSelected ? 'border-purple-300 ring-1 ring-purple-200' : 'border-gray-200'
                  }`}
                >
                  {/* Flow row */}
                  <div className="flex items-center gap-4 px-5 py-4">
                    {/* Checkbox */}
                    <button
                      onClick={() => toggleSelect(flow.id)}
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors shrink-0 ${
                        isSelected
                          ? 'bg-purple-600 border-purple-600'
                          : 'border-gray-300 hover:border-purple-400'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                    </button>

                    {/* Flow number */}
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-100 to-red-100 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-purple-700">{index + 1}</span>
                    </div>

                    {/* Flow name & info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-gray-900">{flow.name}</h3>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-gray-400">{flow.pages.length} pagine</span>
                        <span className="text-xs text-gray-300">•</span>
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Package className="w-3 h-3" />
                          {flow.productName}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Expand pages */}
                      <button
                        onClick={() => setExpandedFlow(isExpanded ? null : flow.id)}
                        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Vedi pagine"
                      >
                        <Eye className="w-4 h-4" />
                      </button>

                      {/* Swipe button */}
                      <div className="relative" ref={isSwipeOpen ? pickerRef : undefined}>
                        <button
                          onClick={() => { setSwipeTarget(isSwipeOpen ? null : flow.id); setShowProductPicker(!isSwipeOpen); }}
                          className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-red-600 text-white rounded-lg text-sm font-medium hover:from-purple-700 hover:to-red-700 transition-all shadow-sm"
                        >
                          <Wand2 className="w-4 h-4" />
                          Swipe
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>

                        {isSwipeOpen && (
                          <div className="absolute top-full right-0 mt-2 w-72 bg-white rounded-xl border border-gray-200 shadow-2xl z-50 max-h-72 overflow-y-auto">
                            <div className="px-4 py-2.5 border-b border-gray-100">
                              <p className="text-xs font-semibold text-gray-500 uppercase">Swippa per prodotto</p>
                            </div>
                            {products.map((p) => (
                              <button
                                key={p.id}
                                onClick={() => handleSwipe(flow.id, p.id)}
                                className="w-full text-left px-4 py-3 text-sm hover:bg-purple-50 flex items-center justify-between transition-colors"
                              >
                                <div>
                                  <p className="font-medium text-gray-800">{p.name}</p>
                                  {p.price > 0 && <p className="text-xs text-gray-400 mt-0.5">€{p.price}</p>}
                                </div>
                                <ChevronRight className="w-4 h-4 text-gray-300" />
                              </button>
                            ))}
                            {products.length === 0 && (
                              <div className="px-4 py-6 text-center text-gray-400 text-sm">Nessun prodotto disponibile</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Pages list */}
                  {isExpanded && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-3">
                    <div className="space-y-2">
                      {flow.pages.map((page, pi) => (
                        <div key={page.id} className="flex items-center gap-3 text-sm">
                          <span className="w-6 text-center text-xs text-gray-400 font-mono">{pi + 1}.</span>
                          <span className="text-gray-700 font-medium flex-1">{page.name}</span>
                          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">{page.pageType}</span>
                          {page.url && (
                            <a href={page.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline truncate max-w-[200px]">
                              {page.url.replace(/^https?:\/\/(www\.)?/, '')}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between text-xs text-gray-400">
          <span>{flows.length} flussi totali</span>
          {selected.size > 0 && (
            <button onClick={toggleAll} className="text-purple-500 hover:text-purple-700">
              {selected.size === flows.length ? 'Deseleziona tutti' : 'Seleziona tutti'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
