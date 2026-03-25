'use client';

import { useState, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Plus, Trash2, X, ChevronDown, ChevronRight,
  FolderOpen, Search, FileText, Clock, CheckCircle,
  Pause, Archive, Image as ImageIcon, Upload, Globe,
  BarChart3, FileEdit, Layers, ShieldCheck, GitBranch, Monitor,
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

  const fileInputRef = useRef<HTMLInputElement>(null);
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
    const url = URL.createObjectURL(file);
    const newAsset: AssetItem = { url, name: file.name, addedAt: new Date().toISOString() };
    const current = (project.logo || []) as AssetItem[];
    updateProject(uploadProjectId, { logo: [...current, newAsset] });
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
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />

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
                            onUploadLogo={() => { setUploadProjectId(project.id); fileInputRef.current?.click(); }}
                            onRemoveLogo={(idx) => removeLogo(project.id, idx)} />
                        )}
                        {activeTab === 'research' && <SectionTab project={project} updateProject={updateProject} sectionKey="marketResearch"
                          title="Market Research" fields={[
                            { key: 'targetAudience', label: 'Target Audience', rows: 3 },
                            { key: 'competitors', label: 'Competitors', rows: 3 },
                            { key: 'positioning', label: 'Positioning', rows: 3 },
                            { key: 'notes', label: 'Research Notes', rows: 4 },
                          ]} />}
                        {activeTab === 'brief' && <BriefTab project={project} updateProject={updateProject} />}
                        {activeTab === 'frontend' && <SectionTab project={project} updateProject={updateProject} sectionKey="frontEnd"
                          title="Front End" fields={[
                            { key: 'landingPage', label: 'Landing Page', rows: 3 },
                            { key: 'salesPage', label: 'Sales Page', rows: 3 },
                            { key: 'optinPage', label: 'Opt-in Page', rows: 3 },
                            { key: 'notes', label: 'Notes', rows: 4 },
                          ]} />}
                        {activeTab === 'backend' && <SectionTab project={project} updateProject={updateProject} sectionKey="backEnd"
                          title="Back End" fields={[
                            { key: 'upsell', label: 'Upsell', rows: 3 },
                            { key: 'downsell', label: 'Downsell', rows: 3 },
                            { key: 'orderBump', label: 'Order Bump', rows: 3 },
                            { key: 'thankYou', label: 'Thank You Page', rows: 3 },
                            { key: 'notes', label: 'Notes', rows: 4 },
                          ]} />}
                        {activeTab === 'compliance' && <SectionTab project={project} updateProject={updateProject} sectionKey="complianceFunnel"
                          title="Compliance Funnel" fields={[
                            { key: 'privacyPolicy', label: 'Privacy Policy', rows: 3 },
                            { key: 'termsConditions', label: 'Terms & Conditions', rows: 3 },
                            { key: 'disclaimer', label: 'Disclaimer', rows: 3 },
                            { key: 'refundPolicy', label: 'Refund Policy', rows: 3 },
                            { key: 'notes', label: 'Notes', rows: 4 },
                          ]} />}
                        {activeTab === 'funnel' && <SectionTab project={project} updateProject={updateProject} sectionKey="funnel"
                          title="Funnel" fields={[
                            { key: 'structure', label: 'Funnel Structure', rows: 4 },
                            { key: 'trafficSources', label: 'Traffic Sources', rows: 3 },
                            { key: 'emailSequence', label: 'Email Sequence', rows: 3 },
                            { key: 'retargeting', label: 'Retargeting', rows: 3 },
                            { key: 'notes', label: 'Notes', rows: 4 },
                          ]} />}
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
        <label className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5 block">
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

      {/* Logo Section */}
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
          <div className="border-2 border-dashed border-gray-200 rounded-lg p-6 text-center">
            <ImageIcon className="w-8 h-8 text-gray-300 mx-auto mb-1" />
            <p className="text-xs text-gray-400">No logo uploaded</p>
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

function SectionTab({ project, updateProject, sectionKey, title, fields }: {
  project: ProjectType; updateProject: UpdateFn;
  sectionKey: 'marketResearch' | 'frontEnd' | 'backEnd' | 'complianceFunnel' | 'funnel';
  title: string;
  fields: { key: string; label: string; rows: number }[];
}) {
  const data = (project[sectionKey] || {}) as Record<string, string>;

  const update = (key: string, value: string) => {
    updateProject(project.id, { [sectionKey]: { ...data, [key]: value } });
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {fields.map(f => (
        <div key={f.key}>
          <label className="text-sm font-medium text-gray-700 mb-1 block">{f.label}</label>
          <textarea value={data[f.key] || ''} onChange={(e) => update(f.key, e.target.value)}
            rows={f.rows} placeholder={`${f.label}...`}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y" />
        </div>
      ))}
    </div>
  );
}

function BriefTab({ project, updateProject }: { project: ProjectType; updateProject: UpdateFn }) {
  return (
    <div className="max-w-3xl">
      <h3 className="text-sm font-semibold text-gray-800 mb-2">Project Brief</h3>
      <p className="text-xs text-gray-400 mb-3">Write a comprehensive brief for this project</p>
      <textarea value={project.brief || ''} onChange={(e) => updateProject(project.id, { brief: e.target.value })}
        rows={16} placeholder="Write your project brief here..."
        className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y leading-relaxed" />
    </div>
  );
}
