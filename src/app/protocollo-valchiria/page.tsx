'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { ArchivedFunnel, PageType } from '@/types/database';
import {
  Swords, ChevronDown, ChevronRight, Package, Check, Wand2,
  ExternalLink, Loader2, CheckSquare, Square,
} from 'lucide-react';

interface StepKey {
  funnelId: string;
  stepIndex: number;
}

const stepKey = (funnelId: string, stepIndex: number) => `${funnelId}::${stepIndex}`;

export default function ProtocolloValchiriaPage() {
  const {
    products, isInitialized, initializeData,
    archivedFunnels, archivedFunnelsLoaded, loadArchivedFunnels,
    addFunnelPage, deleteFunnelPage, funnelPages,
  } = useStore();

  const router = useRouter();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(new Set());
  const [targetProductId, setTargetProductId] = useState<string | null>(null);
  const [showTargetPicker, setShowTargetPicker] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSwipping, setIsSwipping] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const init = async () => {
      if (!isInitialized) await initializeData();
      if (!archivedFunnelsLoaded) await loadArchivedFunnels();
      setIsLoading(false);
    };
    init();
  }, [isInitialized, initializeData, archivedFunnelsLoaded, loadArchivedFunnels]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (targetRef.current && !targetRef.current.contains(e.target as Node)) {
        setShowTargetPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const swipeFunnels = useMemo(() =>
    archivedFunnels.filter((f: ArchivedFunnel) => f.name.includes('[SWIPE]')),
    [archivedFunnels]
  );

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleStep = (funnelId: string, stepIndex: number) => {
    const key = stepKey(funnelId, stepIndex);
    setSelectedSteps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllStepsInFunnel = (funnel: ArchivedFunnel) => {
    const steps = (funnel.steps as { step_index: number }[]) || [];
    const keys = steps.map(s => stepKey(funnel.id, s.step_index));
    const allSelected = keys.every(k => selectedSteps.has(k));

    setSelectedSteps(prev => {
      const next = new Set(prev);
      if (allSelected) {
        keys.forEach(k => next.delete(k));
      } else {
        keys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const isFunnelFullySelected = (funnel: ArchivedFunnel) => {
    const steps = (funnel.steps as { step_index: number }[]) || [];
    return steps.length > 0 && steps.every(s => selectedSteps.has(stepKey(funnel.id, s.step_index)));
  };

  const selectedCount = selectedSteps.size;

  // Normalizza i page_type non standard al formato enum del DB
  const normalizePageType = (pt: string): string => {
    if (!pt) return 'landing';
    const l = pt.toLowerCase();
    if (l.includes('advertorial') || l.includes('pre-sell') || l.includes('presell')) return 'landing';
    if (l.includes('landing') || l.includes('sales page') || l.includes('lp')) return 'landing';
    if (l.includes('checkout') || l.includes('order form') || l.includes('shipping')) return 'checkout';
    if (l.includes('upsell') || l.includes('oto') || l.includes('one time')) return 'upsell';
    if (l.includes('downsell')) return 'downsell';
    if (l.includes('thank') || l.includes('confirmation') || l.includes('post-purchase') || l.includes('post purchase')) return 'thank_you';
    if (l.includes('quiz')) return 'quiz';
    if (l.includes('pre') && l.includes('sell')) return 'landing';
    return 'landing';
  };

  const getSelectedStepDetails = () => {
    const details: { funnelName: string; stepName: string; url: string; pageType: string; prompt: string }[] = [];
    swipeFunnels.forEach(funnel => {
      const steps = (funnel.steps as { step_index: number; name: string; url_to_swipe: string; page_type: string; prompt: string }[]) || [];
      steps.forEach(s => {
        if (selectedSteps.has(stepKey(funnel.id, s.step_index))) {
          details.push({
            funnelName: funnel.name,
            stepName: s.name,
            url: s.url_to_swipe || '',
            pageType: normalizePageType(s.page_type || 'landing'),
            prompt: s.prompt || '',
          });
        }
      });
    });
    return details;
  };

  const handleSwipeSelected = async () => {
    if (!targetProductId || selectedCount === 0) return;
    setIsSwipping(true);

    try {
      // Clear existing funnel pages first
      const existingIds = funnelPages.map(p => p.id);
      for (const id of existingIds) {
        await deleteFunnelPage(id);
      }

      const details = getSelectedStepDetails();

      for (const step of details) {
        await addFunnelPage({
          name: step.stepName,
          pageType: (step.pageType || 'landing') as PageType,
          productId: targetProductId,
          urlToSwipe: step.url,
          prompt: step.prompt,
          swipeStatus: 'pending',
        });
      }

      setSelectedSteps(new Set());
      router.push('/front-end-funnel');
    } catch (error) {
      console.error('Error loading steps into Front End Funnel:', error);
      alert('Errore nel caricamento degli step. Riprova.');
    } finally {
      setIsSwipping(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <span className="ml-3 text-gray-500 font-medium">Caricamento funnel...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-600 to-red-600 rounded-xl shadow-lg">
              <Swords className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Protocollo Valchiria</h1>
              <p className="text-gray-500 text-sm">Espandi ogni funnel, seleziona gli step da swippare</p>
            </div>
          </div>
          {selectedCount > 0 && (
            <div className="bg-purple-50 border border-purple-200 rounded-lg px-4 py-2">
              <span className="text-purple-700 text-sm font-semibold">{selectedCount} step selezionati</span>
            </div>
          )}
        </div>

        {/* Target product + Swipe action */}
        <div className="mb-6 flex items-center gap-4 flex-wrap">
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
                      {p.price > 0 && <p className="text-xs text-gray-400 mt-0.5">&euro;{p.price}</p>}
                    </div>
                    {targetProductId === p.id && <Check className="w-4 h-4 text-purple-600" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {targetProductId && selectedCount > 0 && (
            <button
              onClick={handleSwipeSelected}
              disabled={isSwipping}
              className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-purple-600 to-red-600 text-white rounded-xl text-sm font-semibold hover:from-purple-700 hover:to-red-700 transition-all shadow-md disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSwipping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {isSwipping
                ? 'Caricamento in Front End Funnel...'
                : `Swipe ${selectedCount} step per ${products.find(p => p.id === targetProductId)?.name}`
              }
            </button>
          )}

          {selectedCount > 0 && (
            <button
              onClick={() => setSelectedSteps(new Set())}
              className="text-sm text-gray-400 hover:text-red-500 transition-colors"
            >
              Deseleziona tutti
            </button>
          )}
        </div>

        {/* Funnel list */}
        <div className="space-y-3">
          {swipeFunnels.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
              <Swords className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">Nessun funnel [SWIPE] trovato</p>
              <p className="text-gray-400 text-sm mt-1">Salva funnel con &quot;[SWIPE]&quot; nel nome dalla sezione Saved Funnels</p>
            </div>
          ) : (
            swipeFunnels.map((funnel, index) => {
              const steps = (funnel.steps as { step_index: number; name: string; page_type: string; url_to_swipe: string; product_name: string }[]) || [];
              const isExpanded = expandedIds.has(funnel.id);
              const allSelected = isFunnelFullySelected(funnel);
              const funnelSelectedCount = steps.filter(s => selectedSteps.has(stepKey(funnel.id, s.step_index))).length;

              return (
                <div
                  key={funnel.id}
                  className={`bg-white rounded-xl border shadow-sm transition-all ${
                    allSelected ? 'border-purple-300 ring-1 ring-purple-200' : 'border-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-4 px-5 py-4">
                    {/* Select all steps */}
                    <button
                      onClick={() => toggleAllStepsInFunnel(funnel)}
                      className="shrink-0"
                      title={allSelected ? 'Deseleziona tutti gli step' : 'Seleziona tutti gli step'}
                    >
                      {allSelected
                        ? <CheckSquare className="w-5 h-5 text-purple-600" />
                        : <Square className="w-5 h-5 text-gray-300 hover:text-purple-400" />
                      }
                    </button>

                    {/* Number */}
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-100 to-red-100 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-purple-700">{index + 1}</span>
                    </div>

                    {/* Funnel info (clickable to expand) */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => toggleExpand(funnel.id)}
                    >
                      <h3 className="text-base font-semibold text-gray-900">{funnel.name}</h3>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-gray-400">{funnel.total_steps} step</span>
                        {funnelSelectedCount > 0 && (
                          <>
                            <span className="text-xs text-gray-300">&bull;</span>
                            <span className="text-xs text-purple-500 font-medium">{funnelSelectedCount} selezionati</span>
                          </>
                        )}
                        <span className="text-xs text-gray-300">&bull;</span>
                        <span className="text-xs text-gray-400">
                          {new Date(funnel.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                    </div>

                    {/* Expand chevron */}
                    <button
                      onClick={() => toggleExpand(funnel.id)}
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
                    >
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </button>
                  </div>

                  {/* Steps (expanded) */}
                  {isExpanded && steps.length > 0 && (
                    <div className="border-t border-gray-100 bg-gray-50/50">
                      <div className="divide-y divide-gray-100">
                        {steps.map((s) => {
                          const key = stepKey(funnel.id, s.step_index);
                          const checked = selectedSteps.has(key);
                          return (
                            <div
                              key={key}
                              onClick={() => toggleStep(funnel.id, s.step_index)}
                              className={`flex items-center gap-4 px-5 py-3.5 cursor-pointer transition-colors ${
                                checked ? 'bg-purple-50/60' : 'hover:bg-gray-100/50'
                              }`}
                            >
                              {checked
                                ? <CheckSquare className="w-4.5 h-4.5 text-purple-600 shrink-0" />
                                : <Square className="w-4.5 h-4.5 text-gray-300 shrink-0" />
                              }
                              <span className="w-7 text-center text-xs text-gray-400 font-mono shrink-0">{s.step_index}</span>
                              <span className="text-sm text-gray-800 font-medium flex-1 min-w-0 truncate">{s.name}</span>
                              <span className="text-[11px] text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full shrink-0">{s.page_type || 'other'}</span>
                              {s.url_to_swipe && (
                                <a
                                  href={s.url_to_swipe}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors shrink-0"
                                  title={s.url_to_swipe}
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 text-xs text-gray-400">
          {swipeFunnels.length} funnel &bull; {swipeFunnels.reduce((acc, f) => acc + f.total_steps, 0)} step totali
          {selectedCount > 0 && <span className="ml-2 text-purple-500 font-medium">&bull; {selectedCount} selezionati</span>}
        </div>
      </main>
    </div>
  );
}
