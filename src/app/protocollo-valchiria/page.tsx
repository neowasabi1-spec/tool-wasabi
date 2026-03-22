'use client';

import { useState, useEffect, useRef } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { Swords, ExternalLink, ChevronDown, Package, Check } from 'lucide-react';

export default function ProtocolloValchiriaPage() {
  const { funnelPages, products, isInitialized, initialize } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openProductMenu, setOpenProductMenu] = useState<string | null>(null);
  const [selectedProductFilter, setSelectedProductFilter] = useState<string | null>(null);
  const [showProductFilter, setShowProductFilter] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenProductMenu(null);
      }
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowProductFilter(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(f => f.id)));
    }
  };

  const getProduct = (productId: string) => products.find(p => p.id === productId);

  const selectedFilterProduct = selectedProductFilter ? products.find(p => p.id === selectedProductFilter) : null;

  const filtered = funnelPages.filter(f => {
    if (!selectedProductFilter) return true;
    return f.productId === selectedProductFilter;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-600 to-red-600 rounded-xl shadow-lg">
              <Swords className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Protocollo Valchiria</h1>
              <p className="text-gray-500 text-sm">Strategic operations center</p>
            </div>
          </div>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-lg px-4 py-2">
              <span className="text-purple-700 text-sm font-semibold">{selected.size} flow selected</span>
            </div>
          )}
        </div>

        {/* Product filter */}
        <div className="mb-4 relative" ref={filterRef}>
          <button
            onClick={() => setShowProductFilter(!showProductFilter)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
              selectedFilterProduct
                ? 'bg-purple-50 border-purple-300 text-purple-800 hover:bg-purple-100'
                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Package className="w-4 h-4" />
            {selectedFilterProduct ? selectedFilterProduct.name : 'Select Product'}
            <ChevronDown className={`w-4 h-4 transition-transform ${showProductFilter ? 'rotate-180' : ''}`} />
          </button>

          {showProductFilter && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-xl z-50 max-h-72 overflow-y-auto">
              <button
                onClick={() => { setSelectedProductFilter(null); setShowProductFilter(false); setSelected(new Set()); }}
                className={`w-full text-left px-4 py-3 text-sm hover:bg-gray-50 transition-colors border-b border-gray-100 ${
                  !selectedProductFilter ? 'bg-purple-50 text-purple-700 font-semibold' : 'text-gray-500'
                }`}
              >
                All Products
              </button>
              {products.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setSelectedProductFilter(p.id); setShowProductFilter(false); setSelected(new Set()); }}
                  className={`w-full text-left px-4 py-3 text-sm hover:bg-gray-50 flex items-center justify-between transition-colors ${
                    selectedProductFilter === p.id ? 'bg-purple-50 text-purple-700 font-semibold' : 'text-gray-700'
                  }`}
                >
                  <div>
                    <p className="font-medium">{p.name}</p>
                    {p.price > 0 && <p className="text-xs text-gray-400 mt-0.5">€{p.price}</p>}
                  </div>
                  {selectedProductFilter === p.id && <Check className="w-4 h-4 text-purple-600" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-12 px-4 py-3 text-left">
                  <button
                    onClick={toggleAll}
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                      selected.size === filtered.length && filtered.length > 0
                        ? 'bg-purple-600 border-purple-600'
                        : 'border-gray-300 hover:border-purple-400'
                    }`}
                  >
                    {selected.size === filtered.length && filtered.length > 0 && (
                      <Check className="w-3.5 h-3.5 text-white" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Flow Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Link</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center">
                    <Swords className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-500 font-medium">{selectedProductFilter ? 'No flows for this product' : 'No flows available'}</p>
                    <p className="text-gray-400 text-sm mt-0.5">{selectedProductFilter ? 'Select a different product' : 'Add flows in Front End Funnel first'}</p>
                  </td>
                </tr>
              ) : (
                filtered.map((flow) => {
                  const isSelected = selected.has(flow.id);
                  const product = getProduct(flow.productId);
                  const isMenuOpen = openProductMenu === flow.id;

                  return (
                    <tr
                      key={flow.id}
                      className={`transition-colors ${isSelected ? 'bg-purple-50/50' : 'hover:bg-gray-50'}`}
                    >
                      {/* Checkbox */}
                      <td className="w-12 px-4 py-3">
                        <button
                          onClick={() => toggleSelect(flow.id)}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-purple-600 border-purple-600'
                              : 'border-gray-300 hover:border-purple-400'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                        </button>
                      </td>

                      {/* Flow Name */}
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{flow.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{flow.pageType}</p>
                        </div>
                      </td>

                      {/* Link */}
                      <td className="px-4 py-3">
                        {flow.urlToSwipe ? (
                          <a
                            href={flow.urlToSwipe}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 hover:underline max-w-[280px] truncate"
                          >
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{flow.urlToSwipe.replace(/^https?:\/\/(www\.)?/, '')}</span>
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">No link</span>
                        )}
                      </td>

                      {/* Product dropdown */}
                      <td className="px-4 py-3 relative">
                        <div ref={isMenuOpen ? menuRef : undefined} className="relative">
                          <button
                            onClick={() => setOpenProductMenu(isMenuOpen ? null : flow.id)}
                            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                              product
                                ? 'bg-green-50 border-green-200 text-green-800 hover:bg-green-100'
                                : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                            }`}
                          >
                            <Package className="w-3.5 h-3.5" />
                            <span className="max-w-[150px] truncate">{product ? product.name : 'No product'}</span>
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`} />
                          </button>

                          {isMenuOpen && (
                            <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-lg border border-gray-200 shadow-xl z-50 max-h-60 overflow-y-auto">
                              {products.length === 0 ? (
                                <div className="px-3 py-4 text-center text-gray-400 text-sm">No products available</div>
                              ) : (
                                products.map((p) => (
                                  <button
                                    key={p.id}
                                    onClick={() => setOpenProductMenu(null)}
                                    className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-2 transition-colors ${
                                      p.id === flow.productId ? 'bg-purple-50 text-purple-700 font-medium' : 'text-gray-700'
                                    }`}
                                  >
                                    {p.id === flow.productId && <Check className="w-4 h-4 text-purple-600 shrink-0" />}
                                    <div className={p.id === flow.productId ? '' : 'ml-6'}>
                                      <p className="font-medium truncate">{p.name}</p>
                                      {p.price > 0 && <p className="text-xs text-gray-400">€{p.price}</p>}
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer info */}
        <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
          <span>{filtered.length} flow{filtered.length !== 1 ? 's' : ''} total</span>
          {selected.size > 0 && <span>{selected.size} selected</span>}
        </div>
      </main>
    </div>
  );
}
