'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import { supabase } from '@/lib/supabase';
import {
  Plus, FolderOpen, ChevronRight, ChevronDown, Layers,
  Trash2, Search, Save, X,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FunnelRow {
  step: string;
  url: string;
  price: string;
  offerType: string;
}

interface Project {
  id: string;
  name: string;
  status: string;
  description: string;
  domain: string;
  notes: string;
  created_at: string;
  updated_at: string;
  // JSONB columns – raw from DB
  market_research?: any;
  brief?: any;
  front_end?: any;
  back_end?: any;
  compliance_funnel?: any;
  funnel?: any;
}

const TABS = ['Overview', 'Market Research', 'Brief', 'Front End', 'Back End', 'Compliance', 'Funnel'] as const;
type Tab = (typeof TABS)[number];

const STATUS_OPTIONS = ['active', 'in_progress', 'paused', 'completed', 'archived'];

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-green-900 text-green-300',
  in_progress: 'bg-blue-900 text-blue-300',
  paused: 'bg-yellow-900 text-yellow-300',
  completed: 'bg-emerald-900 text-emerald-300',
  archived: 'bg-gray-800 text-gray-500',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractText(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val.content) return String(val.content);
  return '';
}

function extractRows(val: any): FunnelRow[] {
  if (!val) return [];
  const rows = typeof val === 'object' ? val.rows : null;
  if (Array.isArray(rows)) return rows as FunnelRow[];
  return [];
}

function emptyRow(): FunnelRow {
  return { step: '', url: '', price: '', offerType: '' };
}

// ─── Sub-component: Table Editor ─────────────────────────────────────────────

function TableEditor({
  rows,
  onChange,
}: {
  rows: FunnelRow[];
  onChange: (rows: FunnelRow[]) => void;
}) {
  function update(i: number, field: keyof FunnelRow, val: string) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r));
    onChange(next);
  }

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 border-b border-[#2A2D3A]">
            <th className="text-left py-2 pr-3 font-medium">Step</th>
            <th className="text-left py-2 pr-3 font-medium">URL</th>
            <th className="text-left py-2 pr-3 font-medium">Price</th>
            <th className="text-left py-2 pr-3 font-medium">Offer Type</th>
            <th className="py-2 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[#1A1D27]">
              {(['step', 'url', 'price', 'offerType'] as (keyof FunnelRow)[]).map(field => (
                <td key={field} className="py-1.5 pr-2">
                  <input
                    value={row[field]}
                    onChange={e => update(i, field, e.target.value)}
                    className="w-full bg-[#0F1117] border border-[#2A2D3A] rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                  />
                </td>
              ))}
              <td className="py-1.5 text-center">
                <button
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="text-gray-600 hover:text-red-400 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() => onChange([...rows, emptyRow()])}
        className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
      >
        <Plus className="w-3 h-3" /> Add row
      </button>
    </div>
  );
}

// ─── Sub-component: Expanded Project Panel ───────────────────────────────────

function ProjectPanel({
  project,
  onUpdate,
  onDelete,
}: {
  project: Project;
  onUpdate: (id: string, fields: Partial<Project>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [saving, setSaving] = useState(false);

  // Overview fields
  const [name, setName] = useState(String(project.name || ''));
  const [status, setStatus] = useState(String(project.status || 'active'));
  const [domain, setDomain] = useState(String(project.domain || ''));
  const [description, setDescription] = useState(String(project.description || ''));
  const [notes, setNotes] = useState(String(project.notes || ''));

  // JSONB text fields
  const [marketResearch, setMarketResearch] = useState(extractText(project.market_research));
  const [brief, setBrief] = useState(extractText(project.brief));
  const [compliance, setCompliance] = useState(extractText(project.compliance_funnel));
  const [funnelText, setFunnelText] = useState(extractText(project.funnel));

  // Table fields
  const [frontEndRows, setFrontEndRows] = useState<FunnelRow[]>(extractRows(project.front_end));
  const [backEndRows, setBackEndRows] = useState<FunnelRow[]>(extractRows(project.back_end));

  async function save() {
    setSaving(true);
    await onUpdate(project.id, {
      name,
      status,
      domain,
      description,
      notes,
      market_research: { content: marketResearch },
      brief: brief,
      front_end: { rows: frontEndRows },
      back_end: { rows: backEndRows },
      compliance_funnel: { content: compliance },
      funnel: { content: funnelText },
    });
    setSaving(false);
  }

  const inputCls =
    'w-full bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500';
  const textareaCls =
    'w-full bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-y min-h-[160px]';
  const labelCls = 'block text-xs text-gray-400 mb-1 font-medium';

  return (
    <div className="border-t border-[#2A2D3A] mt-4 pt-4">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
              tab === t
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-[#2A2D3A]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-4">
        {tab === 'Overview' && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Project Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className={inputCls}
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Domain</label>
              <input value={domain} onChange={e => setDomain(e.target.value)} className={inputCls} placeholder="e.g. https://example.com" />
            </div>
            <div>
              <label className={labelCls}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} className={textareaCls} rows={3} />
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} className={textareaCls} rows={3} />
            </div>
          </>
        )}

        {tab === 'Market Research' && (
          <div>
            <label className={labelCls}>Market Research Notes</label>
            <textarea
              value={marketResearch}
              onChange={e => setMarketResearch(e.target.value)}
              className={textareaCls}
              rows={10}
              placeholder="Enter market research, competitor notes, target audience analysis..."
            />
          </div>
        )}

        {tab === 'Brief' && (
          <div>
            <label className={labelCls}>Brief</label>
            <textarea
              value={brief}
              onChange={e => setBrief(e.target.value)}
              className={textareaCls}
              rows={10}
              placeholder="Enter project brief, goals, requirements..."
            />
          </div>
        )}

        {tab === 'Front End' && (
          <div>
            <label className={labelCls}>Front End Funnel Steps</label>
            <TableEditor rows={frontEndRows} onChange={setFrontEndRows} />
          </div>
        )}

        {tab === 'Back End' && (
          <div>
            <label className={labelCls}>Back End Funnel Steps</label>
            <TableEditor rows={backEndRows} onChange={setBackEndRows} />
          </div>
        )}

        {tab === 'Compliance' && (
          <div>
            <label className={labelCls}>Compliance Notes</label>
            <textarea
              value={compliance}
              onChange={e => setCompliance(e.target.value)}
              className={textareaCls}
              rows={10}
              placeholder="Enter compliance requirements, disclaimers, legal notes..."
            />
          </div>
        )}

        {tab === 'Funnel' && (
          <div>
            <label className={labelCls}>Funnel Description</label>
            <textarea
              value={funnelText}
              onChange={e => setFunnelText(e.target.value)}
              className={textareaCls}
              rows={10}
              placeholder="Describe the funnel strategy, flow, and objectives..."
            />
          </div>
        )}

        {/* Save / Delete actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[#2A2D3A]">
          <button
            onClick={() => onDelete(project.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 text-xs rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete Project
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    const { data } = await supabase
      .from('projects')
      .select('id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, front_end, back_end, compliance_funnel, funnel')
      .order('created_at', { ascending: false });

    if (data) {
      setProjects(
        data.map((p: any) => ({
          id: String(p.id || ''),
          name: typeof p.name === 'string' ? p.name : 'Untitled',
          status: typeof p.status === 'string' ? p.status : 'active',
          description: typeof p.description === 'string' ? p.description : '',
          domain: typeof p.domain === 'string' ? p.domain : '',
          notes: typeof p.notes === 'string' ? p.notes : '',
          created_at: typeof p.created_at === 'string' ? p.created_at : '',
          updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
          market_research: p.market_research ?? null,
          brief: p.brief ?? null,
          front_end: p.front_end ?? null,
          back_end: p.back_end ?? null,
          compliance_funnel: p.compliance_funnel ?? null,
          funnel: p.funnel ?? null,
        })),
      );
    }
    setLoading(false);
  }

  async function addProject() {
    if (!newName.trim()) return;
    setAdding(true);
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: newName.trim(), status: 'active', description: '' })
      .select('id, name, status, description, domain, notes, created_at, updated_at, market_research, brief, front_end, back_end, compliance_funnel, funnel')
      .single();
    if (!error && data) {
      const newProject: Project = {
        id: String(data.id),
        name: String(data.name || ''),
        status: String(data.status || 'active'),
        description: '',
        domain: '',
        notes: '',
        created_at: String(data.created_at || ''),
        updated_at: String(data.updated_at || ''),
        market_research: null,
        brief: null,
        front_end: null,
        back_end: null,
        compliance_funnel: null,
        funnel: null,
      };
      setProjects(prev => [newProject, ...prev]);
      setExpandedId(newProject.id);
      setNewName('');
      setShowAdd(false);
    }
    setAdding(false);
  }

  async function updateProject(id: string, fields: Partial<Project>) {
    const { error } = await supabase.from('projects').update(fields).eq('id', id);
    if (!error) {
      setProjects(prev =>
        prev.map(p => (p.id === id ? { ...p, ...fields } : p)),
      );
    }
  }

  async function deleteProject(id: string) {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    await supabase.from('projects').delete().eq('id', id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  // Filter
  const filtered = projects.filter(p => {
    const matchSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.domain.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || p.status === filterStatus;
    return matchSearch && matchStatus;
  });

  return (
    <div className="min-h-screen bg-[#0F1117]">
      <Header title="My Projects" subtitle="Manage your funnel projects" />

      <div className="p-6 max-w-5xl mx-auto">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search projects..."
                className="w-full bg-[#1A1D27] border border-[#2A2D3A] rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Status filter */}
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="bg-[#1A1D27] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <FolderOpen className="w-4 h-4" />
              <span>{filtered.length} project{filtered.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Project
          </button>
        </div>

        {/* Add form */}
        {showAdd && (
          <div className="bg-[#1A1D27] border border-[#2A2D3A] rounded-xl p-4 mb-4">
            <div className="flex gap-3">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addProject()}
                placeholder="Project name..."
                className="flex-1 bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={addProject}
                disabled={adding || !newName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {adding ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => { setShowAdd(false); setNewName(''); }}
                className="px-3 py-2 text-gray-400 hover:text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Project list */}
        {loading ? (
          <div className="text-center text-gray-500 py-20 animate-pulse">Loading projects...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{projects.length === 0 ? 'No projects yet. Create your first one.' : 'No projects match your search.'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(project => {
              const isOpen = expandedId === project.id;
              return (
                <div
                  key={project.id}
                  className={`bg-[#1A1D27] border rounded-xl transition-colors ${
                    isOpen ? 'border-blue-600/50' : 'border-[#2A2D3A] hover:border-[#3A3D4A]'
                  }`}
                >
                  {/* Row header — click to expand */}
                  <div
                    className="flex items-center justify-between p-5 cursor-pointer"
                    onClick={() => toggleExpand(project.id)}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                        <FolderOpen className="w-5 h-5 text-blue-400" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-white font-semibold text-base truncate">{project.name}</h3>
                        {project.description ? (
                          <p className="text-gray-400 text-sm whitespace-pre-line mt-0.5">{project.description}</p>
                        ) : null}
                        {project.domain ? (
                          <p className="text-blue-400 text-xs mt-0.5">{project.domain}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <span
                        className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                          STATUS_COLOR[project.status] || 'bg-gray-700 text-gray-300'
                        }`}
                      >
                        {project.status}
                      </span>

                      {/* Flows button */}
                      <Link
                        href={'/projects/' + project.id}
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        Flows
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>

                      {/* Expand chevron */}
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-blue-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </div>
                  </div>

                  {/* Expanded panel */}
                  {isOpen && (
                    <div className="px-5 pb-5">
                      <ProjectPanel
                        project={project}
                        onUpdate={updateProject}
                        onDelete={deleteProject}
                      />
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
