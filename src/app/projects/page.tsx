'use client';

import { useState, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Plus, Trash2, Edit2, Save, X, ChevronDown, ChevronRight,
  FolderOpen, Tag, Search, FileText, Clock, CheckCircle,
  Pause, Archive, Image as ImageIcon, Upload, Palette,
  BarChart3, ShoppingBag, GitBranch, FileEdit,
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
  { key: 'logo', label: 'Logo', icon: Palette },
  { key: 'mockup', label: 'Mockup', icon: ImageIcon },
  { key: 'label', label: 'Label', icon: Tag },
  { key: 'research', label: 'Market Research', icon: BarChart3 },
  { key: 'products', label: 'Products', icon: ShoppingBag },
  { key: 'flow', label: 'Flow', icon: GitBranch },
  { key: 'brief', label: 'Brief', icon: FileEdit },
] as const;

type TabKey = typeof PROJECT_TABS[number]['key'];

function getStatusInfo(status: string) {
  return STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
}

interface AssetItem {
  url: string;
  name: string;
  addedAt: string;
}

export default function ProjectsPage() {
  const { projects, products, addProject, updateProject, deleteProject } = useStore();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<{ projectId: string; field: 'logo' | 'mockup' | 'label' } | null>(null);

  const filteredProjects = projects.filter(p => {
    if (filterText) {
      const q = filterText.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false;
    }
    if (filterStatus && p.status !== filterStatus) return false;
    return true;
  });

  const toggleExpand = (id: string) => {
    if (expandedProjectId === id) {
      setExpandedProjectId(null);
    } else {
      setExpandedProjectId(id);
      setActiveTab('overview');
    }
  };

  const handleAddProject = () => {
    if (!newName.trim()) return;
    addProject({
      name: newName.trim(),
      description: '',
      status: 'active',
      tags: [],
      notes: '',
      logo: [],
      mockup: [],
      label: [],
      marketResearch: {},
      selectedProducts: [],
      flowSteps: [[], [], [], [], [], []],
      brief: '',
    });
    setNewName('');
    setShowAddForm(false);
  };

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!uploadTarget || !e.target.files?.length) return;
    const file = e.target.files[0];
    const { projectId, field } = uploadTarget;
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    const url = URL.createObjectURL(file);
    const newAsset: AssetItem = { url, name: file.name, addedAt: new Date().toISOString() };
    const current = project[field] as AssetItem[];
    updateProject(projectId, { [field]: [...current, newAsset] });
    e.target.value = '';
    setUploadTarget(null);
  }, [uploadTarget, projects, updateProject]);

  const removeAsset = (projectId: string, field: 'logo' | 'mockup' | 'label', idx: number) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const current = [...(project[field] as AssetItem[])];
    current.splice(idx, 1);
    updateProject(projectId, { [field]: current });
  };

  const hasFilters = filterText || filterStatus;

  return (
    <div className="min-h-screen">
      <Header title="My Projects" subtitle="Manage your projects, assets, flow and briefs" />
      <div className="p-6 max-w-6xl mx-auto">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />

        {/* ── Toolbar ── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <FolderOpen className="w-5 h-5 text-blue-600" />
              <div>
                <h2 className="text-sm font-semibold text-gray-800">Projects ({filteredProjects.length})</h2>
                <p className="text-xs text-gray-500">Create and manage your projects</p>
              </div>
            </div>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                showAddForm ? 'bg-gray-200 text-gray-700' : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {showAddForm ? 'Cancel' : 'Add Project'}
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        {projects.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input type="text" placeholder="Search projects..." value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
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

        {/* ── Quick Add ── */}
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

        {/* ── Project List ── */}
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
                  {/* Header */}
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
                      {project.description && <p className="text-xs text-gray-500 truncate mt-0.5">{project.description}</p>}
                    </div>
                    <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      <StatusIcon className="w-3 h-3" />{statusInfo.label}
                    </span>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { if (confirm(`Delete "${project.name}"?`)) deleteProject(project.id); }}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content with Tabs */}
                  {isExpanded && (
                    <div className="border-t">
                      {/* Tab Bar */}
                      <div className="flex items-center gap-0.5 px-4 py-2 bg-gray-50 border-b overflow-x-auto">
                        {PROJECT_TABS.map(tab => {
                          const TabIcon = tab.icon;
                          return (
                            <button key={tab.key}
                              onClick={() => setActiveTab(tab.key)}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                                activeTab === tab.key
                                  ? 'bg-blue-600 text-white shadow-sm'
                                  : 'text-gray-600 hover:bg-white hover:shadow-sm'
                              }`}>
                              <TabIcon className="w-3.5 h-3.5" />{tab.label}
                            </button>
                          );
                        })}
                      </div>

                      {/* Tab Content */}
                      <div className="p-5">
                        {activeTab === 'overview' && (
                          <OverviewTab project={project} updateProject={updateProject} />
                        )}
                        {activeTab === 'logo' && (
                          <AssetTab project={project} field="logo" label="Logo"
                            onUpload={() => { setUploadTarget({ projectId: project.id, field: 'logo' }); fileInputRef.current?.click(); }}
                            onRemove={(idx) => removeAsset(project.id, 'logo', idx)} />
                        )}
                        {activeTab === 'mockup' && (
                          <AssetTab project={project} field="mockup" label="Mockup"
                            onUpload={() => { setUploadTarget({ projectId: project.id, field: 'mockup' }); fileInputRef.current?.click(); }}
                            onRemove={(idx) => removeAsset(project.id, 'mockup', idx)} />
                        )}
                        {activeTab === 'label' && (
                          <AssetTab project={project} field="label" label="Label"
                            onUpload={() => { setUploadTarget({ projectId: project.id, field: 'label' }); fileInputRef.current?.click(); }}
                            onRemove={(idx) => removeAsset(project.id, 'label', idx)} />
                        )}
                        {activeTab === 'research' && (
                          <ResearchTab project={project} updateProject={updateProject} />
                        )}
                        {activeTab === 'products' && (
                          <ProductsTab project={project} products={products} updateProject={updateProject} />
                        )}
                        {activeTab === 'flow' && (
                          <FlowTab project={project} updateProject={updateProject} />
                        )}
                        {activeTab === 'brief' && (
                          <BriefTab project={project} updateProject={updateProject} />
                        )}
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

/* ═══════════════════════════════════════════════════════════
   TAB COMPONENTS
   ═══════════════════════════════════════════════════════════ */

type ProjectType = ReturnType<typeof useStore.getState>['projects'][number];
type UpdateFn = (id: string, data: Partial<ProjectType>) => Promise<void>;

/* ── Overview Tab ── */
function OverviewTab({ project, updateProject }: { project: ProjectType; updateProject: UpdateFn }) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Name</label>
        <input type="text" value={project.name}
          onChange={(e) => updateProject(project.id, { name: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Status</label>
        <select value={project.status} onChange={(e) => updateProject(project.id, { status: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
          {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Description</label>
        <textarea value={project.description}
          onChange={(e) => updateProject(project.id, { description: e.target.value })}
          rows={3} placeholder="Project description..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Notes</label>
        <textarea value={project.notes || ''}
          onChange={(e) => updateProject(project.id, { notes: e.target.value })}
          rows={4} placeholder="Additional notes..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
        Created: {project.createdAt.toLocaleDateString()} · Updated: {project.updatedAt.toLocaleDateString()}
      </div>
    </div>
  );
}

/* ── Asset Tab (Logo / Mockup / Label) ── */
function AssetTab({ project, field, label, onUpload, onRemove }: {
  project: ProjectType; field: 'logo' | 'mockup' | 'label'; label: string;
  onUpload: () => void; onRemove: (idx: number) => void;
}) {
  const assets = (project[field] || []) as AssetItem[];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">{label} ({assets.length})</h3>
        <button onClick={onUpload}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Upload className="w-3.5 h-3.5" /> Upload {label}
        </button>
      </div>
      {assets.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
          <ImageIcon className="w-10 h-10 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-400">No {label.toLowerCase()} uploaded yet</p>
          <button onClick={onUpload} className="mt-2 text-xs text-blue-600 hover:underline">Upload your first {label.toLowerCase()}</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {assets.map((asset, idx) => (
            <div key={idx} className="relative group border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
              <img src={asset.url} alt={asset.name} className="w-full h-32 object-contain p-2" />
              <div className="px-2 py-1.5 border-t border-gray-100 bg-white">
                <p className="text-[10px] text-gray-500 truncate">{asset.name}</p>
              </div>
              <button onClick={() => onRemove(idx)}
                className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Market Research Tab ── */
function ResearchTab({ project, updateProject }: { project: ProjectType; updateProject: UpdateFn }) {
  const research = project.marketResearch || {};

  const update = (key: string, value: string) => {
    updateProject(project.id, {
      marketResearch: { ...research, [key]: value },
    });
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Target Audience</label>
        <textarea value={research.targetAudience || ''} onChange={(e) => update('targetAudience', e.target.value)}
          rows={3} placeholder="Describe your target audience..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Competitors</label>
        <textarea value={research.competitors || ''} onChange={(e) => update('competitors', e.target.value)}
          rows={3} placeholder="Main competitors and their strategies..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Positioning</label>
        <textarea value={research.positioning || ''} onChange={(e) => update('positioning', e.target.value)}
          rows={3} placeholder="How the product is positioned in the market..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
      <div>
        <label className="text-sm font-medium text-gray-700 mb-1 block">Research Notes</label>
        <textarea value={research.notes || ''} onChange={(e) => update('notes', e.target.value)}
          rows={4} placeholder="Additional research notes..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
      </div>
    </div>
  );
}

/* ── Products Tab ── */
function ProductsTab({ project, products, updateProject }: {
  project: ProjectType;
  products: ReturnType<typeof useStore.getState>['products'];
  updateProject: UpdateFn;
}) {
  const selected = project.selectedProducts || [];
  const [manualName, setManualName] = useState('');
  const [manualDesc, setManualDesc] = useState('');

  const addFromCatalog = (productId: string) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) return;
    if (selected.some(s => s.productId === productId)) return;
    updateProject(project.id, {
      selectedProducts: [...selected, { productId, manualName: prod.name, manualDescription: prod.description }],
    });
  };

  const addManual = () => {
    if (!manualName.trim()) return;
    updateProject(project.id, {
      selectedProducts: [...selected, { manualName: manualName.trim(), manualDescription: manualDesc.trim() }],
    });
    setManualName('');
    setManualDesc('');
  };

  const removeProduct = (idx: number) => {
    const updated = [...selected];
    updated.splice(idx, 1);
    updateProject(project.id, { selectedProducts: updated });
  };

  return (
    <div className="space-y-5">
      {/* From Catalog */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Add from Catalog</h4>
        {products.length === 0 ? (
          <p className="text-xs text-gray-400">No products in catalog. Go to My Products to add some.</p>
        ) : (
          <select onChange={(e) => { if (e.target.value) addFromCatalog(e.target.value); e.target.value = ''; }}
            className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none">
            <option value="">Select a product...</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>{p.name} {p.brandName ? `(${p.brandName})` : ''}</option>
            ))}
          </select>
        )}
      </div>

      {/* Manual */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Add Manual Product</h4>
        <div className="flex gap-2 max-w-2xl">
          <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)}
            placeholder="Product name" onKeyDown={(e) => { if (e.key === 'Enter') addManual(); }}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
          <input type="text" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)}
            placeholder="Description (optional)"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
          <button onClick={addManual} disabled={!manualName.trim()}
            className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Selected Products List */}
      {selected.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Selected Products ({selected.length})</h4>
          <div className="space-y-2">
            {selected.map((sp, idx) => (
              <div key={idx} className="flex items-center gap-3 px-4 py-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 text-xs font-bold shrink-0">
                  {sp.manualName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{sp.manualName}</p>
                  {sp.manualDescription && <p className="text-xs text-gray-500 truncate">{sp.manualDescription}</p>}
                </div>
                {sp.productId && <span className="text-[10px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">Catalog</span>}
                <button onClick={() => removeProduct(idx)} className="p-1 text-gray-400 hover:text-red-600 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Flow Tab (Sheet-like 6 columns) ── */
function FlowTab({ project, updateProject }: { project: ProjectType; updateProject: UpdateFn }) {
  const steps = project.flowSteps || [[], [], [], [], [], []];
  const [inputs, setInputs] = useState<string[]>(['', '', '', '', '', '']);

  const STEP_LABELS = ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6'];
  const STEP_COLORS = [
    'bg-blue-50 border-blue-200',
    'bg-indigo-50 border-indigo-200',
    'bg-violet-50 border-violet-200',
    'bg-purple-50 border-purple-200',
    'bg-fuchsia-50 border-fuchsia-200',
    'bg-pink-50 border-pink-200',
  ];
  const HEADER_COLORS = [
    'bg-blue-600', 'bg-indigo-600', 'bg-violet-600',
    'bg-purple-600', 'bg-fuchsia-600', 'bg-pink-600',
  ];

  const addItem = (colIdx: number) => {
    const val = inputs[colIdx]?.trim();
    if (!val) return;
    const updated = steps.map((col, i) => i === colIdx ? [...col, val] : [...col]);
    updateProject(project.id, { flowSteps: updated });
    setInputs(prev => prev.map((v, i) => i === colIdx ? '' : v));
  };

  const removeItem = (colIdx: number, itemIdx: number) => {
    const updated = steps.map((col, i) => {
      if (i !== colIdx) return [...col];
      const newCol = [...col];
      newCol.splice(itemIdx, 1);
      return newCol;
    });
    updateProject(project.id, { flowSteps: updated });
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Flow Steps</h3>
      <div className="grid grid-cols-6 gap-2 min-w-[700px] overflow-x-auto">
        {STEP_LABELS.map((label, colIdx) => (
          <div key={colIdx} className={`rounded-xl border overflow-hidden ${STEP_COLORS[colIdx]}`}>
            {/* Column Header */}
            <div className={`px-3 py-2 ${HEADER_COLORS[colIdx]} text-white text-xs font-bold text-center`}>
              {label}
            </div>

            {/* Items */}
            <div className="p-2 space-y-1.5 min-h-[120px]">
              {(steps[colIdx] || []).map((item: string, itemIdx: number) => (
                <div key={itemIdx}
                  className="flex items-start gap-1 px-2 py-1.5 bg-white rounded-lg text-xs text-gray-700 shadow-sm border border-white/80 group">
                  <span className="flex-1 break-words">{item}</span>
                  <button onClick={() => removeItem(colIdx, itemIdx)}
                    className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add Input */}
            <div className="px-2 pb-2">
              <div className="flex gap-1">
                <input type="text" value={inputs[colIdx] || ''}
                  onChange={(e) => setInputs(prev => prev.map((v, i) => i === colIdx ? e.target.value : v))}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(colIdx); }}
                  placeholder="Add..."
                  className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none min-w-0" />
                <button onClick={() => addItem(colIdx)}
                  className="p-1 bg-white border border-gray-200 rounded hover:bg-gray-50 transition-colors shrink-0">
                  <Plus className="w-3 h-3 text-gray-500" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Brief Tab ── */
function BriefTab({ project, updateProject }: { project: ProjectType; updateProject: UpdateFn }) {
  return (
    <div className="max-w-3xl">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Project Brief</h3>
      <p className="text-xs text-gray-400 mb-3">Write a comprehensive brief for this project</p>
      <textarea
        value={project.brief || ''}
        onChange={(e) => updateProject(project.id, { brief: e.target.value })}
        rows={16}
        placeholder="Write your project brief here...&#10;&#10;Include goals, strategy, timeline, KPIs, deliverables, and any other relevant information."
        className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y leading-relaxed"
      />
    </div>
  );
}
