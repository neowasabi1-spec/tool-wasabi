'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/Header';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { authFetch } from '@/lib/auth/client-fetch';
import {
  DASHBOARD_SECTIONS,
  ALL_SECTION_IDS,
  SAFE_DEFAULT_SECTIONS,
  type AppUserWithEmail,
  type AppRole,
} from '@/lib/auth/sections';
import {
  Loader2, Plus, Trash2, Save, X, Shield, ShieldCheck,
  UserPlus, KeyRound, ChevronDown, ChevronRight, AlertCircle, CheckCircle,
} from 'lucide-react';

export default function AdminUsersPage() {
  const { user, permissions, loading: meLoading } = useCurrentUser();
  const [users, setUsers] = useState<AppUserWithEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create form
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<AppRole>('user');
  const [newSections, setNewSections] = useState<string[]>(SAFE_DEFAULT_SECTIONS);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/users');
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Failed to load users');
      setUsers(data.users || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meLoading) return;
    if (permissions?.role !== 'master') return; // AuthGate already redirects
    reload();
  }, [meLoading, permissions, reload]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          password: newPassword,
          role: newRole,
          sections: newSections,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Failed to create user');
      setNewEmail('');
      setNewPassword('');
      setNewRole('user');
      setNewSections(SAFE_DEFAULT_SECTIONS);
      setShowCreate(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header title="Users" subtitle="Gestisci chi pu\u00f2 accedere al tool e quali sezioni vede." />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg p-3 flex items-start gap-2 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          {users.length === 0 && !loading
            ? 'Nessun utente ancora.'
            : `${users.length} utente${users.length === 1 ? '' : 'i'}`}
        </p>
        <button
          onClick={() => setShowCreate(v => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
        >
          {showCreate ? <X className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
          {showCreate ? 'Annulla' : 'Nuovo utente'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-purple-400" />
            Crea nuovo utente
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Email</label>
              <input
                type="email"
                required
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                placeholder="nome@dominio.com"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Password (min 8 caratteri)</label>
              <input
                type="text"
                required
                minLength={8}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-purple-500"
                placeholder="password iniziale"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2">Ruolo</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNewRole('user')}
                className={`flex-1 py-2 px-3 rounded-lg text-sm border transition-colors ${
                  newRole === 'user'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <Shield className="w-3.5 h-3.5 inline mr-1.5" />
                User
              </button>
              <button
                type="button"
                onClick={() => setNewRole('master')}
                className={`flex-1 py-2 px-3 rounded-lg text-sm border transition-colors ${
                  newRole === 'master'
                    ? 'bg-amber-600/20 border-amber-500 text-amber-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 inline mr-1.5" />
                Master (tutte le sezioni)
              </button>
            </div>
          </div>

          {newRole === 'user' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Sezioni accessibili</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNewSections([...ALL_SECTION_IDS])}
                    className="text-[11px] text-purple-400 hover:text-purple-300"
                  >
                    Seleziona tutto
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewSections([])}
                    className="text-[11px] text-gray-400 hover:text-white"
                  >
                    Deseleziona tutto
                  </button>
                </div>
              </div>
              <SectionsPicker value={newSections} onChange={setNewSections} />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={busy || !newEmail || !newPassword}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Crea utente
            </button>
          </div>
        </form>
      )}

      {/* Users list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(u => (
            <UserRow
              key={u.user_id}
              user={u}
              isMe={u.user_id === user?.id}
              isExpanded={expandedId === u.user_id}
              onToggle={() => setExpandedId(expandedId === u.user_id ? null : u.user_id)}
              onChanged={reload}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Per-user row with inline edit panel
// ─────────────────────────────────────────────────────────────────

function UserRow({
  user, isMe, isExpanded, onToggle, onChanged, onError,
}: {
  user: AppUserWithEmail;
  isMe: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [draftRole, setDraftRole] = useState<AppRole>(user.role);
  const [draftSections, setDraftSections] = useState<string[]>(user.sections);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Reset draft when the underlying user changes (e.g. after reload).
  useEffect(() => {
    setDraftRole(user.role);
    setDraftSections(user.sections);
    setNewPassword('');
  }, [user.role, user.sections, user.user_id]);

  const dirty = useMemo(() => {
    if (draftRole !== user.role) return true;
    if (newPassword) return true;
    const a = new Set(draftSections);
    const b = new Set(user.sections);
    if (a.size !== b.size) return true;
    for (const s of a) if (!b.has(s)) return true;
    return false;
  }, [draftRole, draftSections, newPassword, user.role, user.sections]);

  async function save() {
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin/users/${user.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: draftRole,
          sections: draftSections,
          ...(newPassword ? { password: newPassword } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Save failed');
      setNewPassword('');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Eliminare l'utente ${user.email}? Non si pu\u00f2 annullare.`)) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin/users/${user.user_id}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Delete failed');
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 hover:bg-gray-800/50 transition-colors text-left"
      >
        {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
        {user.role === 'master' ? (
          <ShieldCheck className="w-5 h-5 text-amber-400 flex-shrink-0" />
        ) : (
          <Shield className="w-5 h-5 text-gray-500 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{user.email}</span>
            {isMe && <span className="text-[10px] uppercase tracking-wider text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded">tu</span>}
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
              user.role === 'master' ? 'bg-amber-500/10 text-amber-300' : 'bg-gray-700 text-gray-300'
            }`}>
              {user.role}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {user.role === 'master'
              ? 'Tutte le sezioni'
              : `${user.sections.length} sezion${user.sections.length === 1 ? 'e' : 'i'}`}
            {user.last_sign_in_at && ` \u00b7 ultimo login ${new Date(user.last_sign_in_at).toLocaleDateString()}`}
          </p>
        </div>
        {savedFlash && (
          <CheckCircle className="w-4 h-4 text-green-400" />
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-gray-800 p-4 space-y-4 bg-gray-950/50">
          {/* Role toggle */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">Ruolo</label>
            <div className="flex gap-2">
              <button
                onClick={() => setDraftRole('user')}
                disabled={busy}
                className={`flex-1 py-2 px-3 rounded-lg text-sm border transition-colors ${
                  draftRole === 'user'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <Shield className="w-3.5 h-3.5 inline mr-1.5" />User
              </button>
              <button
                onClick={() => setDraftRole('master')}
                disabled={busy}
                className={`flex-1 py-2 px-3 rounded-lg text-sm border transition-colors ${
                  draftRole === 'master'
                    ? 'bg-amber-600/20 border-amber-500 text-amber-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 inline mr-1.5" />Master
              </button>
            </div>
          </div>

          {/* Sections (only meaningful for users) */}
          {draftRole === 'user' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Sezioni accessibili</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDraftSections([...ALL_SECTION_IDS])}
                    className="text-[11px] text-purple-400 hover:text-purple-300"
                  >
                    Tutte
                  </button>
                  <button
                    onClick={() => setDraftSections([])}
                    className="text-[11px] text-gray-400 hover:text-white"
                  >
                    Nessuna
                  </button>
                </div>
              </div>
              <SectionsPicker value={draftSections} onChange={setDraftSections} />
            </div>
          )}

          {/* Password reset */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Reset password (lascia vuoto per non cambiare)</label>
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <input
                type="text"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="nuova password (min 8)"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-purple-500"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="flex justify-between items-center pt-2 border-t border-gray-800">
            <button
              onClick={remove}
              disabled={busy || isMe}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-300 hover:text-white hover:bg-red-500/20 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={isMe ? 'Non puoi eliminare il tuo stesso account' : 'Elimina utente'}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Elimina utente
            </button>
            <button
              onClick={save}
              disabled={busy || !dirty}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Salva
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Checkbox grid for picking sections
// ─────────────────────────────────────────────────────────────────

function SectionsPicker({
  value, onChange,
}: { value: string[]; onChange: (next: string[]) => void }) {
  const selected = new Set(value);
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {DASHBOARD_SECTIONS.map(s => {
        const checked = selected.has(s.id);
        return (
          <button
            type="button"
            key={s.id}
            onClick={() => toggle(s.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border transition-colors text-left ${
              checked
                ? 'bg-purple-600/20 border-purple-500 text-purple-100'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
              checked ? 'bg-purple-500 border-purple-400' : 'border-gray-600'
            }`}>
              {checked && <CheckCircle className="w-3 h-3 text-white" />}
            </div>
            <span className="truncate">{s.label}</span>
            {s.masterOnlyByDefault && (
              <span className="text-[9px] uppercase tracking-wider text-amber-400 ml-auto">admin</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
