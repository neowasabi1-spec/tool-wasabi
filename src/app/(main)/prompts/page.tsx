'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import type { SavedPrompt } from '@/types/database';
import {
  Plus,
  Trash2,
  Loader2,
  Star,
  Edit3,
  Save,
  X,
  Search,
  Tag,
  Copy,
  Check,
  Filter,
  BookOpen,
} from 'lucide-react';

const PROMPT_CATEGORIES = [
  { value: 'general', label: 'General', color: 'bg-gray-100 text-gray-700' },
  { value: 'swipe', label: 'Swipe / Rewrite', color: 'bg-green-100 text-green-700' },
  { value: 'clone', label: 'Clone & Adapt', color: 'bg-amber-100 text-amber-700' },
  { value: 'copy', label: 'Copywriting', color: 'bg-blue-100 text-blue-700' },
  { value: 'landing', label: 'Landing Page', color: 'bg-purple-100 text-purple-700' },
  { value: 'quiz', label: 'Quiz Funnel', color: 'bg-pink-100 text-pink-700' },
  { value: 'email', label: 'Email / Follow-up', color: 'bg-indigo-100 text-indigo-700' },
  { value: 'ads', label: 'Ads / Creative', color: 'bg-red-100 text-red-700' },
];

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    content: '',
    category: 'general',
    tags: [] as string[],
  });
  const [tagInput, setTagInput] = useState('');

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({
    title: '',
    content: '',
    category: 'general',
    tags: [] as string[],
  });
  const [newTagInput, setNewTagInput] = useState('');

  const loadPrompts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/prompts');
      const data = await res.json();
      if (data.prompts) setPrompts(data.prompts);
    } catch (err) {
      console.error('Error loading prompts:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  const handleCreate = async () => {
    if (!newForm.title.trim() || !newForm.content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newForm),
      });
      const data = await res.json();
      if (data.prompt) {
        setPrompts(prev => [data.prompt, ...prev]);
        setNewForm({ title: '', content: '', category: 'general', tags: [] });
        setNewTagInput('');
        setShowNewForm(false);
      }
    } catch (err) {
      console.error('Error creating prompt:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...editForm }),
      });
      const data = await res.json();
      if (data.prompt) {
        setPrompts(prev => prev.map(p => (p.id === id ? data.prompt : p)));
        setEditingId(null);
      }
    } catch (err) {
      console.error('Error updating prompt:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this prompt?')) return;
    try {
      await fetch(`/api/prompts?id=${id}`, { method: 'DELETE' });
      setPrompts(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error('Error deleting prompt:', err);
    }
  };

  const handleToggleFavorite = async (prompt: SavedPrompt) => {
    try {
      const res = await fetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prompt.id, is_favorite: !prompt.is_favorite }),
      });
      const data = await res.json();
      if (data.prompt) {
        setPrompts(prev => prev.map(p => (p.id === prompt.id ? data.prompt : p)));
      }
    } catch (err) {
      console.error('Error toggling favorite:', err);
    }
  };

  const handleCopy = (content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const startEdit = (prompt: SavedPrompt) => {
    setEditingId(prompt.id);
    setEditForm({
      title: prompt.title,
      content: prompt.content,
      category: prompt.category,
      tags: prompt.tags || [],
    });
    setTagInput('');
  };

  const addTag = (isNew: boolean) => {
    const input = isNew ? newTagInput.trim() : tagInput.trim();
    if (!input) return;
    if (isNew) {
      if (!newForm.tags.includes(input)) {
        setNewForm(prev => ({ ...prev, tags: [...prev.tags, input] }));
      }
      setNewTagInput('');
    } else {
      if (!editForm.tags.includes(input)) {
        setEditForm(prev => ({ ...prev, tags: [...prev.tags, input] }));
      }
      setTagInput('');
    }
  };

  const removeTag = (tag: string, isNew: boolean) => {
    if (isNew) {
      setNewForm(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }));
    } else {
      setEditForm(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }));
    }
  };

  const getCategoryInfo = (cat: string) =>
    PROMPT_CATEGORIES.find(c => c.value === cat) || PROMPT_CATEGORIES[0];

  const filteredPrompts = prompts.filter(p => {
    const matchSearch =
      !searchQuery ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.tags || []).some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchCategory = filterCategory === 'all' || p.category === filterCategory;
    return matchSearch && matchCategory;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="My Prompts"
        subtitle="Save and manage your reusable prompts across all pages"
      />

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Top Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
          {/* Search */}
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search prompts..."
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            />
          </div>

          {/* Category Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500" />
            <select
              value={filterCategory}
              onChange={e => setFilterCategory(e.target.value)}
              className="px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="all">All categories</option>
              {PROMPT_CATEGORIES.map(cat => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          {/* New Prompt Button */}
          <button
            onClick={() => setShowNewForm(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors text-sm font-medium whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            New Prompt
          </button>
        </div>

        {/* New Prompt Form */}
        {showNewForm && (
          <div className="bg-white rounded-2xl border border-blue-200 shadow-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Plus className="w-5 h-5 text-blue-600" />
                New Prompt
              </h3>
              <button
                onClick={() => {
                  setShowNewForm(false);
                  setNewForm({ title: '', content: '', category: 'general', tags: [] });
                  setNewTagInput('');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                  <input
                    type="text"
                    value={newForm.title}
                    onChange={e => setNewForm(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="E.g.: Swipe Advertorial"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={newForm.category}
                    onChange={e => setNewForm(prev => ({ ...prev, category: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  >
                    {PROMPT_CATEGORIES.map(cat => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Prompt Content *
                </label>
                <textarea
                  value={newForm.content}
                  onChange={e => setNewForm(prev => ({ ...prev, content: e.target.value }))}
                  rows={6}
                  placeholder="Write your prompt here... You can use variables like {product_name}, {brand_name}, {benefits}, etc."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono"
                />
              </div>

              {/* Tags */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newTagInput}
                    onChange={e => setNewTagInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag(true);
                      }
                    }}
                    placeholder="Add tag..."
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  />
                  <button
                    onClick={() => addTag(true)}
                    className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm"
                  >
                    <Tag className="w-4 h-4" />
                  </button>
                </div>
                {newForm.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {newForm.tags.map(tag => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs"
                      >
                        {tag}
                        <button onClick={() => removeTag(tag, true)} className="hover:text-blue-900">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowNewForm(false);
                    setNewForm({ title: '', content: '', category: 'general', tags: [] });
                  }}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={saving || !newForm.title.trim() || !newForm.content.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save Prompt
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl p-4 border border-gray-200">
            <p className="text-2xl font-bold text-gray-900">{prompts.length}</p>
            <p className="text-sm text-gray-500">Total</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-200">
            <p className="text-2xl font-bold text-amber-600">
              {prompts.filter(p => p.is_favorite).length}
            </p>
            <p className="text-sm text-gray-500">Favorites</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-200">
            <p className="text-2xl font-bold text-blue-600">
              {new Set(prompts.map(p => p.category)).size}
            </p>
            <p className="text-sm text-gray-500">Categories</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-200">
            <p className="text-2xl font-bold text-green-600">
              {prompts.reduce((sum, p) => sum + p.use_count, 0)}
            </p>
            <p className="text-sm text-gray-500">Total uses</p>
          </div>
        </div>

        {/* Prompts List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : filteredPrompts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
            <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-600 mb-2">
              {prompts.length === 0 ? 'No saved prompts' : 'No results'}
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              {prompts.length === 0
                ? 'Create your first prompt to get started!'
                : 'Try adjusting the search filters'}
            </p>
            {prompts.length === 0 && (
              <button
                onClick={() => setShowNewForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                <Plus className="w-4 h-4" />
                Create Prompt
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPrompts.map(prompt => {
              const catInfo = getCategoryInfo(prompt.category);
              const isEditing = editingId === prompt.id;

              return (
                <div
                  key={prompt.id}
                  className={`bg-white rounded-xl border ${
                    isEditing ? 'border-blue-300 shadow-lg' : 'border-gray-200 hover:border-gray-300'
                  } transition-all`}
                >
                  {isEditing ? (
                    <div className="p-5 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Title
                          </label>
                          <input
                            type="text"
                            value={editForm.title}
                            onChange={e =>
                              setEditForm(prev => ({ ...prev, title: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Category
                          </label>
                          <select
                            value={editForm.category}
                            onChange={e =>
                              setEditForm(prev => ({ ...prev, category: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                          >
                            {PROMPT_CATEGORIES.map(cat => (
                              <option key={cat.value} value={cat.value}>
                                {cat.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Content
                        </label>
                        <textarea
                          value={editForm.content}
                          onChange={e =>
                            setEditForm(prev => ({ ...prev, content: e.target.value }))
                          }
                          rows={6}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono"
                        />
                      </div>

                      {/* Tags */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Tags
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={tagInput}
                            onChange={e => setTagInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addTag(false);
                              }
                            }}
                            placeholder="Add tag..."
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                          />
                          <button
                            onClick={() => addTag(false)}
                            className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm"
                          >
                            <Tag className="w-4 h-4" />
                          </button>
                        </div>
                        {editForm.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {editForm.tags.map(tag => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs"
                              >
                                {tag}
                                <button
                                  onClick={() => removeTag(tag, false)}
                                  className="hover:text-blue-900"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleUpdate(prompt.id)}
                          disabled={saving}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
                        >
                          {saving ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4" />
                          )}
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <h3 className="font-semibold text-gray-900 text-sm truncate">
                              {prompt.title}
                            </h3>
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-medium ${catInfo.color}`}
                            >
                              {catInfo.label}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600 line-clamp-3 font-mono whitespace-pre-wrap">
                            {prompt.content}
                          </p>
                          {(prompt.tags || []).length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {prompt.tags.map(tag => (
                                <span
                                  key={tag}
                                  className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                            <span>Used {prompt.use_count}x</span>
                            <span>
                              {new Date(prompt.updated_at).toLocaleDateString('en-US')}
                            </span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleToggleFavorite(prompt)}
                            className={`p-2 rounded-lg transition-colors ${
                              prompt.is_favorite
                                ? 'text-amber-500 bg-amber-50 hover:bg-amber-100'
                                : 'text-gray-400 hover:text-amber-500 hover:bg-gray-100'
                            }`}
                            title={prompt.is_favorite ? 'Remove favorite' : 'Add to favorites'}
                          >
                            <Star
                              className="w-4 h-4"
                              fill={prompt.is_favorite ? 'currentColor' : 'none'}
                            />
                          </button>
                          <button
                            onClick={() => handleCopy(prompt.content, prompt.id)}
                            className="p-2 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Copy prompt"
                          >
                            {copiedId === prompt.id ? (
                              <Check className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => startEdit(prompt)}
                            className="p-2 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Edit"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(prompt.id)}
                            className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
