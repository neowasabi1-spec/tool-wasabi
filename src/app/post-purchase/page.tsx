'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { POST_PURCHASE_TYPE_OPTIONS, STATUS_OPTIONS, PostPurchasePage } from '@/types';
import {
  Plus,
  Trash2,
  Play,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  Eye,
  Code,
} from 'lucide-react';

export default function PostPurchaseFunnel() {
  const {
    products,
    postPurchasePages,
    addPostPurchasePage,
    updatePostPurchasePage,
    deletePostPurchasePage,
    launchPostPurchaseSwipe,
  } = useStore();

  const [loadingIds, setLoadingIds] = useState<string[]>([]);
  const [htmlPreviewModal, setHtmlPreviewModal] = useState<{
    isOpen: boolean;
    title: string;
    html: string;
    metadata: { method: string; length: number; duration: number } | null;
  }>({ isOpen: false, title: '', html: '', metadata: null });

  const handleAddPage = () => {
    addPostPurchasePage({
      name: 'New Post Purchase Page',
      type: 'thank_you',
      productId: products[0]?.id || '',
      urlToSwipe: '',
      swipeStatus: 'pending',
    });
  };

  const handleLaunchSwipe = async (id: string) => {
    setLoadingIds((prev) => [...prev, id]);
    await launchPostPurchaseSwipe(id);
    setLoadingIds((prev) => prev.filter((i) => i !== id));
    
    // Auto-open preview if swipe was successful
    const updatedPage = useStore.getState().postPurchasePages.find((p) => p.id === id);
    if (updatedPage?.swipedData) {
      setHtmlPreviewModal({
        isOpen: true,
        title: updatedPage.swipedData.newTitle || updatedPage.name,
        html: updatedPage.swipedData.html,
        metadata: {
          method: updatedPage.swipedData.methodUsed,
          length: updatedPage.swipedData.newLength,
          duration: updatedPage.swipedData.processingTime,
        },
      });
    }
  };

  const getStatusBadge = (status: string) => {
    const statusOption = STATUS_OPTIONS.find((s) => s.value === status);
    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium ${
          statusOption?.color || 'bg-gray-200'
        }`}
      >
        {statusOption?.label || status}
      </span>
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Post Purchase Funnel"
        subtitle="Manage upsell, downsell and post-purchase pages"
      />

      <div className="p-6">
        {/* Toolbar */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={handleAddPage}
              className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Page
            </button>
            <span className="text-gray-500">
              {postPurchasePages.length} total pages
            </span>
          </div>
          <div className="text-sm text-gray-500">
            Click on cells to edit
          </div>
        </div>

        {/* Excel-style Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="excel-table text-sm">
              <thead>
                <tr>
                  <th className="w-10 px-2">#</th>
                  <th className="min-w-[120px]">Page</th>
                  <th className="min-w-[100px]">Type</th>
                  <th className="min-w-[100px]">Product</th>
                  <th className="min-w-[180px]">URL</th>
                  <th className="w-20">Status</th>
                  <th className="min-w-[120px]">Result</th>
                  <th className="w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {postPurchasePages.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-gray-500">
                      No pages. Click "Add Page" to get started.
                    </td>
                  </tr>
                ) : (
                  postPurchasePages.map((page, index) => (
                    <tr key={page.id}>
                      {/* Row Number */}
                      <td className="text-center text-gray-500 bg-gray-50">
                        {index + 1}
                      </td>

                      {/* Page Name */}
                      <td>
                        <input
                          type="text"
                          value={page.name}
                          onChange={(e) =>
                            updatePostPurchasePage(page.id, { name: e.target.value })
                          }
                          className="font-medium truncate"
                        />
                      </td>

                      {/* Type */}
                      <td>
                        <select
                          value={page.type}
                          onChange={(e) =>
                            updatePostPurchasePage(page.id, {
                              type: e.target.value as PostPurchasePage['type'],
                            })
                          }
                        >
                          {POST_PURCHASE_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Product */}
                      <td>
                        <select
                          value={page.productId}
                          onChange={(e) =>
                            updatePostPurchasePage(page.id, {
                              productId: e.target.value,
                            })
                          }
                          className="truncate"
                        >
                          <option value="">Product...</option>
                          {products.map((prod) => (
                            <option key={prod.id} value={prod.id}>
                              {prod.name}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* URL to Swipe */}
                      <td>
                        <div className="flex items-center gap-0.5">
                          <input
                            type="url"
                            value={page.urlToSwipe}
                            onChange={(e) =>
                              updatePostPurchasePage(page.id, {
                                urlToSwipe: e.target.value,
                              })
                            }
                            placeholder="https://..."
                            className="flex-1 truncate"
                          />
                          {page.urlToSwipe && (
                            <a
                              href={page.urlToSwipe}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:text-blue-700 p-0.5 flex-shrink-0"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="text-center">
                        {getStatusBadge(page.swipeStatus)}
                      </td>

                      {/* Swipe Result */}
                      <td>
                        <div className="flex items-center gap-1">
                          {page.swipeStatus === 'completed' && (
                            <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0" />
                          )}
                          {page.swipeStatus === 'failed' && (
                            <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
                          )}
                          <span className="truncate max-w-[80px]" title={page.swipeResult || ''}>
                            {page.swipeResult || '-'}
                          </span>
                          {(page.swipedData || page.clonedData) && (
                            <button
                              onClick={() => {
                                if (page.swipedData) {
                                  setHtmlPreviewModal({
                                    isOpen: true,
                                    title: page.swipedData.newTitle || page.name,
                                    html: page.swipedData.html,
                                    metadata: {
                                      method: page.swipedData.methodUsed,
                                      length: page.swipedData.newLength,
                                      duration: page.swipedData.processingTime,
                                    },
                                  });
                                } else if (page.clonedData) {
                                  setHtmlPreviewModal({
                                    isOpen: true,
                                    title: page.clonedData!.title || page.name,
                                    html: page.clonedData!.html,
                                    metadata: {
                                      method: page.clonedData!.method_used,
                                      length: page.clonedData!.content_length,
                                      duration: page.clonedData!.duration_seconds,
                                    },
                                  });
                                }
                              }}
                              className="p-1 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded"
                              title="Preview"
                            >
                              <Eye className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Actions */}
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleLaunchSwipe(page.id)}
                            disabled={
                              loadingIds.includes(page.id) ||
                              page.swipeStatus === 'in_progress' ||
                              !page.urlToSwipe ||
                              !page.productId
                            }
                            className={`p-1 rounded transition-colors ${
                              loadingIds.includes(page.id) ||
                              page.swipeStatus === 'in_progress'
                                ? 'bg-yellow-100 text-yellow-700'
                                : !page.urlToSwipe || !page.productId
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-green-100 text-green-700 hover:bg-green-200'
                            }`}
                            title={!page.productId ? 'Select product first' : 'Swipe'}
                          >
                            {loadingIds.includes(page.id) ||
                            page.swipeStatus === 'in_progress' ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => deletePostPurchasePage(page.id)}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Post Purchase Page Types</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {POST_PURCHASE_TYPE_OPTIONS.map((opt) => (
              <div key={opt.value} className="flex items-center gap-2">
                <div className="w-3 h-3 bg-purple-500 rounded-full"></div>
                <span className="text-sm text-gray-600">{opt.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HTML Preview Modal */}
      {htmlPreviewModal.isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-purple-600 to-pink-600">
              <div className="flex items-center gap-3">
                <Code className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-xl font-bold text-white">
                    {htmlPreviewModal.title}
                  </h2>
                  {htmlPreviewModal.metadata && (
                    <p className="text-white/80 text-sm">
                      Method: {htmlPreviewModal.metadata.method} | 
                      {htmlPreviewModal.metadata.length.toLocaleString()} chars | 
                      {htmlPreviewModal.metadata.duration.toFixed(2)}s
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setHtmlPreviewModal({ isOpen: false, title: '', html: '', metadata: null })}
                className="text-white/80 hover:text-white text-2xl font-bold"
              >
                ×
              </button>
            </div>

            {/* Modal Body - Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex border-b border-gray-200">
                <button
                  className="px-4 py-2 text-sm font-medium text-purple-600 border-b-2 border-purple-600"
                >
                  Preview
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(htmlPreviewModal.html);
                    alert('HTML copied to clipboard!');
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
                >
                  Copy HTML
                </button>
              </div>
              
              {/* Preview iframe */}
              <div className="flex-1 overflow-hidden bg-gray-100 p-2">
                <iframe
                  srcDoc={htmlPreviewModal.html}
                  className="w-full h-full bg-white rounded border border-gray-300"
                  sandbox="allow-same-origin"
                  title="HTML Preview"
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
              <button
                onClick={() => {
                  const blob = new Blob([htmlPreviewModal.html], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${htmlPreviewModal.title.replace(/[^a-z0-9]/gi, '_')}.html`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                Download HTML
              </button>
              <button
                onClick={() => setHtmlPreviewModal({ isOpen: false, title: '', html: '', metadata: null })}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
