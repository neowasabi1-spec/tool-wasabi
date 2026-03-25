'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Plus, Trash2, Edit2, Save, X, ChevronDown, ChevronRight,
  FolderOpen, Tag, Search, FileText, Clock, CheckCircle,
  AlertCircle, Pause, Archive,
} from 'lucide-react';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-100 text-blue-700', icon: Clock },
  { value: 'paused', label: 'Paused', color: 'bg-yellow-100 text-yellow-700', icon: Pause },
  { value: 'completed', label: 'Completed', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle },
  { value: 'archived', label: 'Archived', color: 'bg-gray-100 text-gray-500', icon: Archive },
];

function getStatusInfo(status: string) {
  return STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
}

interface NewProjectForm {
  name: string;
  description: string;
  status: string;
  tags: string[];
  notes: string;
}

const emptyForm: NewProjectForm = {
  name: '',
  description: '',
  status: 'active',
  tags: [],
  notes: '',
};

export default function ProjectsPage() {
  const { projects, addProject, updateProject, deleteProject } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProject, setNewProject] = useState<NewProjectForm>(emptyForm);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterTag, setFilterTag] = useState('');

  const uniqueTags = [...new Set(projects.flatMap(p => p.tags))].sort();

  const filteredProjects = projects.filter(p => {
    if (filterText) {
      const q = filterText.toLowerCase();
      const match = p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.notes || '').toLowerCase().includes(q);
      if (!match) return false;
    }
    if (filterStatus && p.status !== filterStatus) return false;
    if (filterTag && !p.tags.includes(filterTag)) return false;
    return true;
  });

  const toggleExpand = (id: string) => {
    setExpandedProjectId(expandedProjectId === id ? null : id);
    if (expandedProjectId !== id) setEditingId(null);
  };

  const handleAddProject = () => {
    if (!newProject.name.trim()) return;
    addProject({
      ...newProject,
      tags: newProject.tags.filter(t => t.trim() !== ''),
    });
    setNewProject(emptyForm);
    setShowAddForm(false);
    setTagInput('');
  };

  const addTag = (tag: string, target: 'new' | string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (target === 'new') {
      if (!newProject.tags.includes(trimmed)) {
        setNewProject({ ...newProject, tags: [...newProject.tags, trimmed] });
      }
    } else {
      const project = projects.find(p => p.id === target);
      if (project && !project.tags.includes(trimmed)) {
        updateProject(target, { tags: [...project.tags, trimmed] });
      }
    }
    setTagInput('');
  };

  const removeTag = (tag: string, target: 'new' | string) => {
    if (target === 'new') {
      setNewProject({ ...newProject, tags: newProject.tags.filter(t => t !== tag) });
    } else {
      const project = projects.find(p => p.id === target);
      if (project) {
        updateProject(target, { tags: project.tags.filter(t => t !== tag) });
      }
    }
  };

  const hasFilters = filterText || filterStatus || filterTag;

  return (
    <div className="min-h-screen">
      <Header
        title="My Projects"
        subtitle="Manage your projects and track their progress"
      />
      <div className="p-6 max-w-5xl mx-auto">
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
                showAddForm
                  ? 'bg-gray-200 text-gray-700'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
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
                <input
                  type="text"
                  placeholder="Search projects..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                <option value="">All Status</option>
                {STATUS_OPTIONS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              {uniqueTags.length > 0 && (
                <select
                  value={filterTag}
                  onChange={(e) => setFilterTag(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="">All Tags</option>
                  {uniqueTags.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              )}
              {hasFilters && (
                <button
                  onClick={() => { setFilterText(''); setFilterStatus(''); setFilterTag(''); }}
                  className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Add Form ── */}
        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-blue-600" /> New Project
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Name *</label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  placeholder="Project name"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Status</label>
                <select
                  value={newProject.status}
                  onChange={(e) => setNewProject({ ...newProject, status: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-gray-700 mb-1 block">Description</label>
                <textarea
                  value={newProject.description}
                  onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  placeholder="Project description..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-gray-700 mb-1 block">Tags</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {newProject.tags.map(tag => (
                    <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                      {tag}
                      <button onClick={() => removeTag(tag, 'new')} className="hover:text-red-600"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput, 'new'); } }}
                    placeholder="Add tag and press Enter"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                  <button onClick={() => addTag(tagInput, 'new')} className="px-3 py-2 bg-gray-100 rounded-lg text-sm hover:bg-gray-200 transition-colors">
                    <Tag className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-gray-700 mb-1 block">Notes</label>
                <textarea
                  value={newProject.notes}
                  onChange={(e) => setNewProject({ ...newProject, notes: e.target.value })}
                  placeholder="Additional notes..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowAddForm(false); setNewProject(emptyForm); setTagInput(''); }}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddProject}
                disabled={!newProject.name.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Project
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
              const isEditing = editingId === project.id;
              const statusInfo = getStatusInfo(project.status);
              const StatusIcon = statusInfo.icon;

              return (
                <div key={project.id} className={`bg-white rounded-xl border overflow-hidden shadow-sm transition-all ${isExpanded ? 'border-blue-200 shadow-md' : 'border-gray-200 hover:shadow-md'}`}>
                  {/* Collapsed Header */}
                  <div
                    className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                    onClick={() => toggleExpand(project.id)}
                  >
                    <div className="text-gray-400">
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm shrink-0">
                      {project.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-800 truncate">{project.name}</h3>
                      {project.description && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">{project.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
                        <StatusIcon className="w-3 h-3" />
                        {statusInfo.label}
                      </span>
                      {project.tags.length > 0 && (
                        <span className="text-xs text-gray-400">{project.tags.length} tags</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => { setEditingId(isEditing ? null : project.id); setExpandedProjectId(project.id); }}
                        className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Delete "${project.name}"?`)) deleteProject(project.id); }}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className={`border-t px-5 py-5 ${isEditing ? 'bg-blue-50/30' : 'bg-gray-50/50'}`}>
                      {isEditing ? (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="text-sm font-medium text-gray-700 mb-1 block">Name</label>
                              <input
                                type="text"
                                value={project.name}
                                onChange={(e) => updateProject(project.id, { name: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="text-sm font-medium text-gray-700 mb-1 block">Status</label>
                              <select
                                value={project.status}
                                onChange={(e) => updateProject(project.id, { status: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              >
                                {STATUS_OPTIONS.map(s => (
                                  <option key={s.value} value={s.value}>{s.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="md:col-span-2">
                              <label className="text-sm font-medium text-gray-700 mb-1 block">Description</label>
                              <textarea
                                value={project.description}
                                onChange={(e) => updateProject(project.id, { description: e.target.value })}
                                rows={3}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <label className="text-sm font-medium text-gray-700 mb-1 block">Tags</label>
                              <div className="flex flex-wrap gap-1.5 mb-2">
                                {project.tags.map(tag => (
                                  <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                                    {tag}
                                    <button onClick={() => removeTag(tag, project.id)} className="hover:text-red-600"><X className="w-3 h-3" /></button>
                                  </span>
                                ))}
                              </div>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={editingId === project.id ? tagInput : ''}
                                  onChange={(e) => setTagInput(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput, project.id); } }}
                                  placeholder="Add tag and press Enter"
                                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                />
                              </div>
                            </div>
                            <div className="md:col-span-2">
                              <label className="text-sm font-medium text-gray-700 mb-1 block">Notes</label>
                              <textarea
                                value={project.notes || ''}
                                onChange={(e) => updateProject(project.id, { notes: e.target.value })}
                                rows={4}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button
                              onClick={() => setEditingId(null)}
                              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                            >
                              <Save className="w-4 h-4" /> Done
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {project.description && (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                <FileText className="w-3 h-3" /> Description
                              </h4>
                              <p className="text-sm text-gray-700 whitespace-pre-wrap">{project.description}</p>
                            </div>
                          )}
                          {project.tags.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                <Tag className="w-3 h-3" /> Tags
                              </h4>
                              <div className="flex flex-wrap gap-1.5">
                                {project.tags.map(tag => (
                                  <span key={tag} className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {project.notes && (
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" /> Notes
                              </h4>
                              <p className="text-sm text-gray-700 whitespace-pre-wrap bg-white rounded-lg p-3 border border-gray-100">{project.notes}</p>
                            </div>
                          )}
                          <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
                            Created: {project.createdAt.toLocaleDateString()} · Updated: {project.updatedAt.toLocaleDateString()}
                          </div>
                        </div>
                      )}
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
