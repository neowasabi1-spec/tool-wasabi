'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import { supabase } from '@/lib/supabase';
import { Plus, FolderOpen, ChevronRight, Layers, Trash2 } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  status: string;
  description: string;
  domain: string;
  created_at: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    const { data } = await supabase
      .from('projects')
      .select('id, name, status, description, domain, created_at')
      .order('created_at', { ascending: false });

    if (data) {
      setProjects(data.map((p: any) => ({
        id: String(p.id || ''),
        name: typeof p.name === 'string' ? p.name : 'Untitled',
        status: typeof p.status === 'string' ? p.status : 'active',
        description: typeof p.description === 'string' ? p.description : '',
        domain: typeof p.domain === 'string' ? p.domain : '',
        created_at: typeof p.created_at === 'string' ? p.created_at : '',
      })));
    }
    setLoading(false);
  }

  async function addProject() {
    if (!newName.trim()) return;
    setAdding(true);
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: newName.trim(), status: 'active', description: '' })
      .select('id, name, status, description, domain, created_at')
      .single();
    if (!error && data) {
      setProjects(prev => [{
        id: String(data.id),
        name: String(data.name || ''),
        status: String(data.status || 'active'),
        description: '',
        domain: '',
        created_at: String(data.created_at || ''),
      }, ...prev]);
      setNewName('');
      setShowAdd(false);
    }
    setAdding(false);
  }

  async function deleteProject(id: string) {
    if (!confirm('Delete this project?')) return;
    await supabase.from('projects').delete().eq('id', id);
    setProjects(prev => prev.filter(p => p.id !== id));
  }

  const STATUS_COLOR: Record<string, string> = {
    active: 'bg-green-900 text-green-300',
    in_progress: 'bg-blue-900 text-blue-300',
    paused: 'bg-yellow-900 text-yellow-300',
    completed: 'bg-emerald-900 text-emerald-300',
    archived: 'bg-gray-800 text-gray-500',
  };

  return (
    <div className="min-h-screen bg-[#0F1117]">
      <Header title="My Projects" subtitle="Manage your funnel projects" />

      <div className="p-6 max-w-5xl mx-auto">

        {/* Header actions */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2 text-gray-400">
            <FolderOpen className="w-5 h-5" />
            <span className="text-sm">{projects.length} projects</span>
          </div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
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
                onClick={() => setShowAdd(false)}
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
        ) : projects.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No projects yet. Create your first one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {projects.map(project => (
              <div
                key={project.id}
                className="bg-[#1A1D27] border border-[#2A2D3A] hover:border-[#3A3D4A] rounded-xl p-5 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                      <FolderOpen className="w-5 h-5 text-blue-400" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-white font-semibold text-base truncate">{project.name}</h3>
                      {project.description ? (
                        <p className="text-gray-400 text-sm truncate mt-0.5">{project.description}</p>
                      ) : null}
                      {project.domain ? (
                        <p className="text-blue-400 text-xs mt-0.5">{project.domain}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLOR[project.status] || 'bg-gray-700 text-gray-300'}`}>
                      {project.status}
                    </span>

                    <Link
                      href={`/projects/${project.id}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      Flows
                      <ChevronRight className="w-3.5 h-3.5" />
                    </Link>

                    <button
                      onClick={() => deleteProject(project.id)}
                      className="p-1.5 text-gray-600 hover:text-red-400 transition-colors rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
