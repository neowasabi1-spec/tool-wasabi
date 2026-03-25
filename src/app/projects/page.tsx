'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Plus, Trash2, X, ChevronDown, ChevronRight,
  FolderOpen, Search, FileText, Clock, CheckCircle,
  Pause, Archive, Image as ImageIcon, Upload, Globe,
  BarChart3, FileEdit, Layers, ShieldCheck, GitBranch, Monitor,
  Paperclip,
} from 'lucide-react';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-100 text-blue-700', icon: Clock },
  { value: 'paused', label: 'Paused', color: 'bg-yellow-100 text-yellow-700', icon: Pause },
  { value: 'completed', label: 'Completed', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle },
  { value: 'archived', label: 'Archived', color: 'bg-gray-100 text-gray-500', icon: Archive },
];

const PROJECT_TABS = [
  { key: 'overview', label: 'Overview', icon: FileText },
  { key: 'research', label: 'Market Research', icon: BarChart3 },
  { key: 'brief', label: 'Brief', icon: FileEdit },
  { key: 'frontend', label: 'Front End', icon: Monitor },
  { key: 'backend', label: 'Back End', icon: Layers },
  { key: 'compliance', label: 'Compliance Funnel', icon: ShieldCheck },
  { key: 'funnel', label: 'Funnel', icon: GitBranch },
] as const;

type TabKey = typeof PROJECT_TABS[number]['key'];

function getStatusInfo(status: string) {
  return STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
}

interface AssetItem { url: string; name: string; addedAt: string; }
interface TableRow { step: string; mockup: string; label: string; offer: string; }

type ProjectType = ReturnType<typeof useStore.getState>['projects'][number];
type UpdateFn = (id: string, data: Partial<ProjectType>) => Promise<void>;

export default function ProjectsPage() {
  const { projects, addProject, updateProject, deleteProject } = useStore();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const logoInputRef = useRef<HTMLInputElement>(null);
  const [uploadProjectId, setUploadProjectId] = useState<string | null>(null);

  const filteredProjects = projects.filter(p => {
    if (filterText && !p.name.toLowerCase().includes(filterText.toLowerCase()) && !p.description.toLowerCase().includes(filterText.toLowerCase())) return false;
    if (filterStatus && p.status !== filterStatus) return false;
    return true;
  });

  const toggleExpand = (id: string) => {
    if (expandedProjectId === id) { setExpandedProjectId(null); }
    else { setExpandedProjectId(id); setActiveTab('overview'); }
  };

  const handleAddProject = () => {
    if (!newName.trim()) return;
    addProject({
      name: newName.trim(), description: '', status: 'active', tags: [], notes: '',
      domain: '', logo: [], marketResearch: {}, brief: '',
      frontEnd: {}, backEnd: {}, complianceFunnel: {}, funnel: {},
    });
    setNewName(''); setShowAddForm(false);
  };

  const handleLogoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!uploadProjectId || !e.target.files?.length) return;
    const file = e.target.files[0];
    const project = projects.find(p => p.id === uploadProjectId);
    if (!project) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const newAsset: AssetItem = { url: dataUrl, name: file.name, addedAt: new Date().toISOString() };
      const current = (project.logo || []) as AssetItem[];
      updateProject(uploadProjectId, { logo: [...current, newAsset] });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
    setUploadProjectId(null);
  }, [uploadProjectId, projects, updateProject]);

  const removeLogo = (projectId: string, idx: number) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const current = [...((project.logo || []) as AssetItem[])];
    current.splice(idx, 1);
    updateProject(projectId, { logo: current });
  };

  const hasFilters = filterText || filterStatus;

  return (
    <div className="min-h-screen">
      <Header title="My Projects" subtitle="Manage your projects, research, funnels and briefs" />
      <div className="p-6 max-w-6xl mx-auto">
        <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />

        {/* Toolbar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <FolderOpen className="w-5 h-5 text-blue-600" />
              <div>
                <h2 className="text-sm font-semibold text-gray-800">Projects ({filteredProjects.length})</h2>
                <p className="text-xs text-gray-500">Create and manage your projects</p>
              </div>
            </div>
            <button onClick={() => setShowAddForm(!showAddForm)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${showAddForm ? 'bg-gray-200 text-gray-700' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
              {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {showAddForm ? 'Cancel' : 'Add Project'}
            </button>
          </div>
        </div>

        {/* Filters */}
        {projects.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input type="text" placeholder="Search projects..." value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">All Status</option>
                {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {hasFilters && (
                <button onClick={() => { setFilterText(''); setFilterStatus(''); }}
                  className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors">Clear</button>
              )}
            </div>
          </div>
        )}

        {/* Quick Add */}
        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <Plus className="w-5 h-5 text-blue-600" /> New Project
            </h3>
            <div className="flex gap-3">
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddProject(); }}
                placeholder="Project name" autoFocus
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              <button onClick={handleAddProject} disabled={!newName.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                Create
              </button>
            </div>
          </div>
        )}

        {/* Project List */}
        {filteredProjects.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-gray-600">No projects yet</h3>
            <p className="text-sm text-gray-400 mt-1">
              {hasFilters ? 'No projects match your filters' : 'Click "Add Project" to create your first project'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredProjects.map((project) => {
              const isExpanded = expandedProjectId === project.id;
              const statusInfo = getStatusInfo(project.status);
              const StatusIcon = statusInfo.icon;

              return (
                <div key={project.id} className={`bg-white rounded-xl border overflow-hidden shadow-sm transition-all ${isExpanded ? 'border-blue-200 shadow-md' : 'border-gray-200 hover:shadow-md'}`}>
                  <div className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                    onClick={() => toggleExpand(project.id)}>
                    <div className="text-gray-400">
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm shrink-0">
                      {project.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-800 truncate">{project.name}</h3>
                      {project.domain && <p className="text-xs text-gray-500 truncate mt-0.5">{project.domain}</p>}
                    </div>
                    <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      <StatusIcon className="w-3 h-3" />{statusInfo.label}
                    </span>
                    <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { if (confirm(`Delete "${project.name}"?`)) deleteProject(project.id); }}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t">
                      <div className="flex items-center gap-0.5 px-4 py-2 bg-gray-50 border-b overflow-x-auto">
                        {PROJECT_TABS.map(tab => {
                          const TabIcon = tab.icon;
                          return (
                            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                                activeTab === tab.key ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-white hover:shadow-sm'
                              }`}>
                              <TabIcon className="w-3.5 h-3.5" />{tab.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="p-5">
                        {activeTab === 'overview' && (
                          <OverviewTab project={project} updateProject={updateProject}
                            onUploadLogo={() => { setUploadProjectId(project.id); logoInputRef.current?.click(); }}
                            onRemoveLogo={(idx) => removeLogo(project.id, idx)} />
                        )}
                        {activeTab === 'research' && <RichBoxTab project={project} updateProject={updateProject} sectionKey="marketResearch" title="Market Research" />}
                        {activeTab === 'brief' && <RichBoxTab project={project} updateProject={updateProject} sectionKey="brief" title="Brief" isBrief />}
                        {activeTab === 'frontend' && <GridTab project={project} updateProject={updateProject} sectionKey="frontEnd" title="Front End" />}
                        {activeTab === 'backend' && <GridTab project={project} updateProject={updateProject} sectionKey="backEnd" title="Back End" />}
                        {activeTab === 'compliance' && <GridTab project={project} updateProject={updateProject} sectionKey="complianceFunnel" title="Compliance Funnel" />}
                        {activeTab === 'funnel' && <GridTab project={project} updateProject={updateProject} sectionKey="funnel" title="Funnel" />}
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

/* ═══ Tab Components ═══ */

function OverviewTab({ project, updateProject, onUploadLogo, onRemoveLogo }: {
  project: ProjectType; updateProject: UpdateFn;
  onUploadLogo: () => void; onRemoveLogo: (idx: number) => void;
}) {
  const logos = (project.logo || []) as AssetItem[];

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-gray-700 mb-1 block">Name</label>
          <input type="text" value={project.name} onChange={(e) => updateProject(project.id, { name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700 mb-1 block">Status</label>
          <select value={project.status} onChange={(e) => updateProject(project.id, { status: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5 text-gray-500" /> Domain
        </label>
        <input type="text" value={project.domain || ''} onChange={(e) => updateProject(project.id, { domain: e.target.value })}
          placeholder="https://example.com"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Description</label>
        <textarea value={project.description} onChange={(e) => updateProject(project.id, { description: e.target.value })}
          rows={3} placeholder="Project description..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Notes</label>
        <textarea value={project.notes || ''} onChange={(e) => updateProject(project.id, { notes: e.target.value })}
          rows={3} placeholder="Additional notes..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>

      {/* Logo */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-gray-500" /> Logo
          </label>
          <button onClick={onUploadLogo}
            className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <Upload className="w-3 h-3" /> Upload
          </button>
        </div>
        {logos.length === 0 ? (
          <div className="border-2 border-dashed border-gray-200 rounded-lg p-6 text-center cursor-pointer hover:border-blue-300 transition-colors" onClick={onUploadLogo}>
            <ImageIcon className="w-8 h-8 text-gray-300 mx-auto mb-1" />
            <p className="text-xs text-gray-400">Click to upload logo</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {logos.map((logo, idx) => (
              <div key={idx} className="relative group border border-gray-200 rounded-lg overflow-hidden bg-gray-50 w-28 h-28">
                <img src={logo.url} alt={logo.name} className="w-full h-full object-contain p-2" />
                <button onClick={() => onRemoveLogo(idx)}
                  className="absolute top-1 right-1 p-0.5 bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
        Created: {project.createdAt.toLocaleDateString()} · Updated: {project.updatedAt.toLocaleDateString()}
      </div>
    </div>
  );
}

/* ── Rich Box Tab (Market Research / Brief) ── */
function RichBoxTab({ project, updateProject, sectionKey, title, isBrief }: {
  project: ProjectType; updateProject: UpdateFn;
  sectionKey: string; title: string; isBrief?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const textValue = isBrief
    ? (project.brief || '')
    : ((project[sectionKey as keyof ProjectType] as Record<string, string>)?.content || '');

  const attachments: AssetItem[] = isBrief
    ? ((project.marketResearch as Record<string, unknown>)?.briefAttachments as AssetItem[] || [])
    : ((project[sectionKey as keyof ProjectType] as Record<string, unknown>)?.attachments as AssetItem[] || []);

  const updateText = (val: string) => {
    if (isBrief) {
      updateProject(project.id, { brief: val });
    } else {
      const current = (project[sectionKey as keyof ProjectType] || {}) as Record<string, unknown>;
      updateProject(project.id, { [sectionKey]: { ...current, content: val } });
    }
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const newAttach: AssetItem = { url: dataUrl, name: file.name, addedAt: new Date().toISOString() };

      if (isBrief) {
        const current = (project.marketResearch || {}) as Record<string, unknown>;
        const existing = (current.briefAttachments as AssetItem[] || []);
        updateProject(project.id, { marketResearch: { ...current, briefAttachments: [...existing, newAttach] } });
      } else {
        const current = (project[sectionKey as keyof ProjectType] || {}) as Record<string, unknown>;
        const existing = (current.attachments as AssetItem[] || []);
        updateProject(project.id, { [sectionKey]: { ...current, attachments: [...existing, newAttach] } });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const removeAttach = (idx: number) => {
    if (isBrief) {
      const current = (project.marketResearch || {}) as Record<string, unknown>;
      const existing = [...(current.briefAttachments as AssetItem[] || [])];
      existing.splice(idx, 1);
      updateProject(project.id, { marketResearch: { ...current, briefAttachments: existing } });
    } else {
      const current = (project[sectionKey as keyof ProjectType] || {}) as Record<string, unknown>;
      const existing = [...(current.attachments as AssetItem[] || [])];
      existing.splice(idx, 1);
      updateProject(project.id, { [sectionKey]: { ...current, attachments: existing } });
    }
  };

  return (
    <div className="max-w-4xl">
      <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" className="hidden" onChange={handleUpload} />
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        <button onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
          <Paperclip className="w-3 h-3" /> Upload File
        </button>
      </div>
      <textarea value={textValue} onChange={(e) => updateText(e.target.value)}
        rows={14} placeholder={`Write your ${title.toLowerCase()} here... or upload files below.`}
        className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y leading-relaxed" />
      {attachments.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-medium text-gray-500">Attachments</p>
          {attachments.map((att, idx) => (
            <div key={idx} className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 text-xs">
              <Paperclip className="w-3 h-3 text-gray-400 shrink-0" />
              <span className="flex-1 truncate text-gray-700">{att.name}</span>
              <button onClick={() => removeAttach(idx)} className="text-gray-400 hover:text-red-500 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Grid Tab (Front End / Back End / Compliance / Funnel) ── */
function GridTab({ project, updateProject, sectionKey, title }: {
  project: ProjectType; updateProject: UpdateFn;
  sectionKey: 'frontEnd' | 'backEnd' | 'complianceFunnel' | 'funnel'; title: string;
}) {
  const storeData = (project[sectionKey] || {}) as Record<string, unknown>;
  const storeRows = (storeData.rows as TableRow[] || []);
  const [rows, setRows] = useState<TableRow[]>(storeRows);

  useEffect(() => {
    setRows((storeData.rows as TableRow[] || []));
  }, [project.id, sectionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const persistRows = useCallback((newRows: TableRow[]) => {
    updateProject(project.id, { [sectionKey]: { ...storeData, rows: newRows } } as Record<string, unknown>);
  }, [project.id, sectionKey, updateProject, storeData]);

  const addRow = () => {
    const newRows = [...rows, { step: '', mockup: '', label: '', offer: '' }];
    setRows(newRows);
    persistRows(newRows);
  };

  const updateCell = (rowIdx: number, col: keyof TableRow, value: string) => {
    const newRows = rows.map((r, i) => i === rowIdx ? { ...r, [col]: value } : r);
    setRows(newRows);
    persistRows(newRows);
  };

  const removeRow = (idx: number) => {
    const newRows = rows.filter((_, i) => i !== idx);
    setRows(newRows);
    persistRows(newRows);
  };

  const COL_HEADERS = [
    { key: 'step' as const, label: 'Step', color: 'bg-blue-600' },
    { key: 'mockup' as const, label: 'Mockup', color: 'bg-indigo-600' },
    { key: 'label' as const, label: 'Label', color: 'bg-violet-600' },
    { key: 'offer' as const, label: 'Offer', color: 'bg-purple-600' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        <button onClick={addRow}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="w-3 h-3" /> Add Row
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[600px]">
          <thead>
            <tr>
              {COL_HEADERS.map(col => (
                <th key={col.key} className={`${col.color} text-white text-xs font-bold px-3 py-2 text-left first:rounded-tl-lg`}>
                  {col.label}
                </th>
              ))}
              <th className="bg-gray-400 text-white text-xs font-bold px-2 py-2 rounded-tr-lg w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-8 text-sm text-gray-400 border border-gray-200">
                  No rows yet. Click &quot;Add Row&quot; to start.
                </td>
              </tr>
            ) : (
              rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="group">
                  {COL_HEADERS.map(col => (
                    <td key={col.key} className="border border-gray-200 p-0">
                      <input type="text" value={row[col.key]} onChange={(e) => updateCell(rowIdx, col.key, e.target.value)}
                        placeholder={col.label}
                        className="w-full px-3 py-2.5 text-sm outline-none focus:bg-blue-50 transition-colors" />
                    </td>
                  ))}
                  <td className="border border-gray-200 p-0 text-center">
                    <button onClick={() => removeRow(rowIdx)}
                      className="p-1.5 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
