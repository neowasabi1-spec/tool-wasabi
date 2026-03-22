'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Clock,
  RefreshCw,
  AlertTriangle,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { API_PERMISSION_OPTIONS, type ApiPermission } from '@/types/database';

interface ApiKeyData {
  id: string;
  name: string;
  description: string;
  key_prefix: string;
  permissions: ApiPermission[];
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPermissions, setNewPermissions] = useState<ApiPermission[]>(['full_access']);
  const [newExpiry, setNewExpiry] = useState('');
  const [creating, setCreating] = useState(false);

  // Newly created key (show once)
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Expanded key details
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Docs panel
  const [showDocs, setShowDocs] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/api-keys');
      const data = await res.json();
      if (data.keys) setKeys(data.keys);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          description: newDescription,
          permissions: newPermissions,
          expires_at: newExpiry || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setRevealedKey(data.raw_key);
      setShowCreate(false);
      setNewName('');
      setNewDescription('');
      setNewPermissions(['full_access']);
      setNewExpiry('');
      loadKeys();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    await fetch('/api/api-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, is_active: !isActive }),
    });
    loadKeys();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete API key "${name}"? This cannot be undone.`)) return;
    await fetch('/api/api-keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    loadKeys();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const togglePermission = (perm: ApiPermission) => {
    if (perm === 'full_access') {
      setNewPermissions(['full_access']);
      return;
    }
    const filtered = newPermissions.filter(p => p !== 'full_access');
    if (filtered.includes(perm)) {
      setNewPermissions(filtered.filter(p => p !== perm));
    } else {
      setNewPermissions([...filtered, perm]);
    }
  };

  const permCategories = [...new Set(API_PERMISSION_OPTIONS.map(p => p.category))];

  const getPermissionLabels = (perms: ApiPermission[]) => {
    if (perms.includes('full_access')) return [{ label: 'Full Access', color: 'bg-red-100 text-red-700' }];
    return perms.map(p => {
      const opt = API_PERMISSION_OPTIONS.find(o => o.value === p);
      return { label: opt?.label || p, color: 'bg-blue-100 text-blue-700' };
    });
  };

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="min-h-screen">
      <Header title="API Keys" subtitle="Generate access keys for external tools and integrations" />

      <div className="p-6 max-w-5xl mx-auto">
        {/* Revealed Key Banner */}
        {revealedKey && (
          <div className="mb-6 bg-amber-50 border-2 border-amber-300 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-bold text-amber-800 text-lg">Save your API key now</h3>
                <p className="text-amber-700 text-sm mt-1">This is the only time you will see this key. Copy it and store it securely.</p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 bg-white border border-amber-300 rounded-lg px-4 py-3 text-sm font-mono select-all break-all">
                    {revealedKey}
                  </code>
                  <button
                    onClick={() => copyToClipboard(revealedKey)}
                    className="px-4 py-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors flex items-center gap-2"
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <button
                  onClick={() => setRevealedKey(null)}
                  className="mt-3 text-sm text-amber-600 hover:text-amber-800 underline"
                >
                  I have saved this key, dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              <Plus className="w-4 h-4" />
              Create API Key
            </button>
            <button
              onClick={() => setShowDocs(!showDocs)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium transition-colors ${
                showDocs ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <ExternalLink className="w-4 h-4" />
              API Docs
            </button>
          </div>
          <button onClick={loadKeys} className="p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* API Docs Panel */}
        {showDocs && (
          <div className="mb-6 bg-gray-900 text-gray-100 rounded-xl p-6 font-mono text-sm">
            <h3 className="text-lg font-bold text-white mb-4 font-sans">API Reference</h3>
            <p className="text-gray-400 mb-4 font-sans text-sm">All endpoints require an API key via the <code className="bg-gray-800 px-1.5 py-0.5 rounded">X-API-Key</code> header.</p>
            <div className="space-y-4">
              <div>
                <p className="text-green-400">GET {baseUrl}/api/v1/products</p>
                <p className="text-gray-500 text-xs">Permission: read_products | full_access</p>
              </div>
              <div>
                <p className="text-yellow-400">POST {baseUrl}/api/v1/products</p>
                <p className="text-gray-500 text-xs">Permission: write_products | full_access</p>
              </div>
              <div>
                <p className="text-green-400">GET {baseUrl}/api/v1/funnels</p>
                <p className="text-gray-500 text-xs">Permission: read_funnels | full_access</p>
              </div>
              <div>
                <p className="text-yellow-400">POST {baseUrl}/api/v1/funnels</p>
                <p className="text-gray-500 text-xs">Permission: write_funnels | full_access</p>
              </div>
              <div>
                <p className="text-green-400">GET {baseUrl}/api/v1/templates</p>
                <p className="text-gray-500 text-xs">Permission: read_templates | full_access</p>
              </div>
              <div>
                <p className="text-green-400">GET {baseUrl}/api/v1/archive</p>
                <p className="text-gray-500 text-xs">Permission: read_archive | full_access</p>
              </div>
              <div>
                <p className="text-yellow-400">POST {baseUrl}/api/v1/chat</p>
                <p className="text-gray-500 text-xs">Permission: ai_chat | full_access</p>
              </div>
            </div>
            <div className="mt-5 pt-4 border-t border-gray-700">
              <div className="mb-4">
                <p className="text-red-400 font-bold font-sans text-sm mb-1">FULL ACCESS PROXY (requires full_access permission)</p>
                <p className="text-yellow-400">POST {baseUrl}/api/v1/proxy</p>
                <p className="text-gray-500 text-xs mb-2">Call ANY internal API route through a single endpoint</p>
                <p className="text-gray-400 font-sans text-xs mb-1">Body format:</p>
                <pre className="text-green-300 text-xs bg-gray-800 p-3 rounded-lg overflow-x-auto">{`{
  "method": "POST",
  "path": "/api/product-brief",
  "body": { "product": { "name": "..." } }
}`}</pre>
              </div>
              <div className="pt-3 border-t border-gray-700">
                <p className="text-gray-400 font-sans text-xs mb-1">List all available routes:</p>
                <code className="text-blue-300 text-xs break-all">
                  curl -H &quot;X-API-Key: fsk_your_key_here&quot; {baseUrl}/api/v1/proxy
                </code>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-700">
                <p className="text-gray-400 font-sans text-xs mb-1">Example - Read products:</p>
                <code className="text-blue-300 text-xs break-all">
                  curl -H &quot;X-API-Key: fsk_your_key_here&quot; {baseUrl}/api/v1/products
                </code>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
          </div>
        )}

        {/* Keys List */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Loading keys...
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-20">
            <Key className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-600">No API keys yet</h3>
            <p className="text-gray-400 mt-1">Create one to connect external tools like OpenClaw.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {keys.map((k) => (
              <div key={k.id} className={`bg-white rounded-xl border ${k.is_active ? 'border-gray-200' : 'border-red-200 bg-red-50/30'} overflow-hidden`}>
                <div className="p-4 flex items-center gap-4">
                  <div className={`p-2 rounded-lg ${k.is_active ? 'bg-green-100' : 'bg-red-100'}`}>
                    {k.is_active ? <ShieldCheck className="w-5 h-5 text-green-600" /> : <ShieldAlert className="w-5 h-5 text-red-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{k.name}</h3>
                      {!k.is_active && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Disabled</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <code className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{k.key_prefix}</code>
                      <span className="text-xs text-gray-400">
                        Created {new Date(k.created_at).toLocaleDateString()}
                      </span>
                      {k.last_used_at && (
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Last used {new Date(k.last_used_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getPermissionLabels(k.permissions).map((p, i) => (
                      <span key={i} className={`text-xs px-2 py-1 rounded-full font-medium ${p.color}`}>{p.label}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}
                      className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                      title="Details"
                    >
                      {expandedId === k.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => handleToggle(k.id, k.is_active)}
                      className={`p-2 rounded-lg transition-colors ${k.is_active ? 'text-amber-500 hover:bg-amber-50' : 'text-green-500 hover:bg-green-50'}`}
                      title={k.is_active ? 'Disable' : 'Enable'}
                    >
                      {k.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => handleDelete(k.id, k.name)}
                      className="p-2 text-red-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {expandedId === k.id && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-gray-500">Description:</span>
                        <p className="text-gray-700">{k.description || '—'}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Expires:</span>
                        <p className="text-gray-700">{k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'Never'}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Permissions:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {k.permissions.map(p => {
                            const opt = API_PERMISSION_OPTIONS.find(o => o.value === p);
                            return <span key={p} className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded">{opt?.label || p}</span>;
                          })}
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-500">ID:</span>
                        <code className="text-xs text-gray-600 block mt-1">{k.id}</code>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="p-6 border-b border-gray-100">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Key className="w-5 h-5 text-blue-600" />
                  Create API Key
                </h2>
                <p className="text-sm text-gray-500 mt-1">Generate a new key for external tool access</p>
              </div>
              <div className="p-6 space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. OpenClaw Integration"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <input
                    type="text"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="What is this key used for?"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
                  {permCategories.map(cat => (
                    <div key={cat} className="mb-3">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{cat}</p>
                      <div className="space-y-1">
                        {API_PERMISSION_OPTIONS.filter(p => p.category === cat).map(perm => (
                          <label
                            key={perm.value}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                              newPermissions.includes(perm.value)
                                ? perm.value === 'full_access' ? 'bg-red-50 border border-red-200' : 'bg-blue-50 border border-blue-200'
                                : 'bg-gray-50 border border-transparent hover:bg-gray-100'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={newPermissions.includes(perm.value)}
                              onChange={() => togglePermission(perm.value)}
                              className="rounded"
                            />
                            <div>
                              <span className="text-sm font-medium text-gray-800">{perm.label}</span>
                              <p className="text-xs text-gray-500">{perm.description}</p>
                            </div>
                            {perm.value === 'full_access' && (
                              <Shield className="w-4 h-4 text-red-500 ml-auto" />
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Expiration (optional)</label>
                  <input
                    type="date"
                    value={newExpiry}
                    onChange={(e) => setNewExpiry(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">Leave empty for no expiration</p>
                </div>
              </div>
              <div className="p-6 border-t border-gray-100 flex justify-end gap-3">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || newPermissions.length === 0 || creating}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                  Generate Key
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
