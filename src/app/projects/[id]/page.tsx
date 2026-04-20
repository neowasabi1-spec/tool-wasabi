'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';
import { supabase } from '@/lib/supabase';
import { ArrowLeft, Plus, Layers, ChevronRight, Trash2, X, Clock, CheckCircle, Pause, Archive } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  status: string;
  description: string;
  domain: string;
}

interface Flow {
  id: string;
  name: string;
  status: string;
  is_active: boolean;
  created_at: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-700 text-gray-300',
  live: 'bg-green-900 text-green-300',
  paused: 'bg-yellow-900 text-yellow-300',
  archived: 'bg-gray-800 text-gray-500',
};

export default function ProjectDetailPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
  const resolvedParams = params instanceof Promise ? use(params) : params;
  const id = resolvedParams.id;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { loadData(); }, [id]);

  async function loadData() {
    setLoading(true);
    const [pRes, fRes] = await Promise.all([
      supabase.from('projects').select('id, name, status, description, domain').eq('id', id).single(),
      supabase.from('funnel_flows').select('id, name, status, is_active, created_at').eq('project_id', id).order('created_at', { ascending: false }),
    ]);
    if (pRes.data) {
      const p = pRes.data;
      setProject({
        id: String(p.id || ''),
        name: typeof p.name === 'string' ? p.name : 'Untitled',
        status: typeof p.status === 'string' ? p.status : 'active',
        description: typeof p.description === 'string' ? p.description : '',
        domain: typeof p.domain === 'string' ? p.domain : '',
      });
    }
    if (fRes.data) {
      setFlows(fRes.data.map((f: any) => ({
        id: String(f.id || ''),
        name: typeof f.name === 'string' ? f.name : 'Flow',
        status: typeof f.status === 'string' ? f.status : 'draft',
        is_active: Boolean(f.is_active),
        created_at: typeof f.created_at === 'string' ? f.created_at : '',
      })));
    }
    setLoading(false);
  }

  async function addFlow() {
    if (!newName.trim()) return;
    setAdding(true);
    const { data, error } = await supabase
      .from('funnel_flows')
      .insert({ project_id: id, name: newName.trim(), status: 'draft', is_active: false })
      .select('id, name, status, is_active, created_at')
      .single();
    if (!error && data) {
      setFlows(prev => [{
        id: String(data.id),
        name: String(data.name || ''),
        status: String(data.status || 'draft'),
        is_active: Boolean(data.is_active),
        created_at: String(data.created_at || ''),
      }, ...prev]);
      setNewName('');
      setShowAdd(false);
    }
    setAdding(false);
  }

  async function deleteFlow(flowId: string) {
    if (!confirm('Delete this flow and all its steps?')) return;
    await supabase.from('funnel_flows').delete().eq('id', flowId);
    setFlows(prev => prev.filter(f => f.id !== flowId));
  }

  if (loading) return (
    <div className="min-h-screen bg-[#0F1117] flex items-center justify-center">
      <div className="text-gray-400 animate-pulse">Loading...</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0F1117]">
      <Header title={project?.name || 'Project'} subtitle="Funnel Flows" />
      <div className="p-6 max-w-4xl mx-auto">

        <button onClick={() => router.push('/projects')} className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 text-sm transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Projects
        </button>

        {project && (
          <div className="bg-[#1A1D27] border border-[#2A2D3A] rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">{project.name}</h2>
                {project.description ? <p className="text-gray-400 text-sm mt-1 whitespace-pre-line" style={{ whiteSpace: 'pre-line' }}>{project.description}</p> : null}
                {project.domain ? <p className="text-blue-400 text-xs mt-1">{project.domain}</p> : null}
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-medium bg-blue-900 text-blue-300">{project.status}</span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-gray-400">
            <Layers className="w-5 h-5" />
            <span className="text-sm font-medium text-white">Flows ({flows.length})</span>
          </div>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showAdd ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showAdd ? 'Cancel' : 'Add Flow'}
          </button>
        </div>

        {showAdd && (
          <div className="bg-[#1A1D27] border border-[#2A2D3A] rounded-xl p-4 mb-4">
            <div className="flex gap-3">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addFlow()}
                placeholder="Flow name (e.g. Flow A — Nooro Swipe)"
                className="flex-1 bg-[#0F1117] border border-[#2A2D3A] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <button onClick={addFlow} disabled={adding || !newName.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                {adding ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {flows.length === 0 ? (
          <div className="text-center text-gray-500 py-20">
            <Layers className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No flows yet. Add your first flow.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {flows.map(flow => (
              <div key={flow.id} className="bg-[#1A1D27] border border-[#2A2D3A] hover:border-[#3A3D4A] rounded-xl p-4 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-indigo-600/20 flex items-center justify-center flex-shrink-0">
                      <Layers className="w-4 h-4 text-indigo-400" />
                    </div>
                    <div>
                      <h4 className="text-white font-medium">{flow.name}</h4>
                      <p className="text-gray-500 text-xs mt-0.5">{flow.created_at ? new Date(flow.created_at).toLocaleDateString('it-IT') : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLOR[flow.status] || 'bg-gray-700 text-gray-300'}`}>
                      {flow.status}
                    </span>
                    <Link
                      href={`/projects/${id}/flow/${flow.id}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      Open <ChevronRight className="w-3.5 h-3.5" />
                    </Link>
                    <button onClick={() => deleteFlow(flow.id)} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors rounded">
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
