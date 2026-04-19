'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Plus, ChevronRight, X, Check, ExternalLink,
  Newspaper, Play, ShoppingCart, TrendingUp, TrendingDown,
  CheckCircle, Mail, ArrowRight, Trash2, BarChart2,
  Code, Settings, FileText, Eye,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

/* ─── Types ─── */
interface Flow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: string;
  is_active: boolean;
}

interface FlowStep {
  id: string;
  flow_id: string;
  project_id: string | null;
  step_number: number;
  step_type: string;
  name: string;
  copy_text: string | null;
  html_content: string | null;
  live_url: string | null;
  preview_image: string | null;
  status: string;
  visits: number;
  conversions: number;
  cvr: number;
  revenue: number;
  price: number | null;
  offer_type: string | null;
}

/* ─── Constants ─── */
const STEP_TYPES = [
  { value: 'advertorial', label: 'Advertorial', icon: Newspaper, color: '#6366f1' },
  { value: 'vsl', label: 'VSL', icon: Play, color: '#8b5cf6' },
  { value: 'checkout', label: 'Checkout', icon: ShoppingCart, color: '#0ea5e9' },
  { value: 'upsell', label: 'Upsell', icon: TrendingUp, color: '#22c55e' },
  { value: 'oto', label: 'OTO', icon: TrendingUp, color: '#16a34a' },
  { value: 'downsell', label: 'Downsell', icon: TrendingDown, color: '#f97316' },
  { value: 'thank_you', label: 'Thank You', icon: CheckCircle, color: '#10b981' },
  { value: 'optin', label: 'Opt-in', icon: Mail, color: '#f59e0b' },
  { value: 'bridge', label: 'Bridge', icon: ArrowRight, color: '#94a3b8' },
];

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  ready: '#3b82f6',
  live: '#22c55e',
};

function getStepMeta(type: string) {
  return STEP_TYPES.find(t => t.value === type) || STEP_TYPES[0];
}

/* ─── Step Card ─── */
function StepCard({ step, onClick, isSelected }: {
  step: FlowStep;
  onClick: () => void;
  isSelected: boolean;
}) {
  const meta = getStepMeta(step.step_type);
  const Icon = meta.icon;
  const statusColor = STATUS_COLORS[step.status] || '#6b7280';

  return (
    <div
      onClick={onClick}
      className={`relative flex-shrink-0 w-44 rounded-xl border-2 cursor-pointer transition-all select-none
        ${isSelected
          ? 'border-blue-500 shadow-lg shadow-blue-500/20'
          : 'border-[#2A2D3A] hover:border-[#4A4D5A]'
        } bg-[#1A1D27]`}
    >
      {/* Step number badge */}
      <div className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-[#252836] border border-[#3A3D4A] flex items-center justify-center">
        <span className="text-xs font-bold text-gray-400">{step.step_number}</span>
      </div>

      <div className="p-4">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
          style={{ backgroundColor: `${meta.color}22` }}
        >
          <Icon className="w-5 h-5" style={{ color: meta.color }} />
        </div>

        {/* Name */}
        <h4 className="text-sm font-semibold text-white truncate mb-2">{step.name}</h4>

        {/* Status badge */}
        <div className="flex items-center gap-1.5 mb-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
          <span className="text-xs capitalize" style={{ color: statusColor }}>{step.status}</span>
        </div>

        {/* Stats */}
        <div className="space-y-1">
          {step.cvr > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">CVR</span>
              <span className="text-xs font-medium text-green-400">{step.cvr}%</span>
            </div>
          )}
          {step.price != null && step.price > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Price</span>
              <span className="text-xs font-medium text-blue-400">${step.price}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Arrow Connector ─── */
function Arrow() {
  return (
    <div className="flex-shrink-0 flex items-center px-1">
      <div className="flex items-center gap-0.5">
        <div className="w-8 h-px bg-[#3A3D4A]" />
        <ChevronRight className="w-4 h-4 text-[#3A3D4A]" />
      </div>
    </div>
  );
}

/* ─── Side Panel ─── */
type TabType = 'copy' | 'html' | 'settings' | 'kpi';

function SidePanel({ step, onClose, onUpdate, onDelete }: {
  step: FlowStep;
  onClose: () => void;
  onUpdate: (updates: Partial<FlowStep>) => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<TabType>('copy');
  const [localStep, setLocalStep] = useState(step);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setLocalStep(step); }, [step.id]);

  function updateLocal(key: keyof FlowStep, value: unknown) {
    setLocalStep(prev => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    onUpdate(localStep);
    setSaving(false);
  }

  const tabs: { id: TabType; label: string; icon: React.ElementType }[] = [
    { id: 'copy', label: 'Copy', icon: FileText },
    { id: 'html', label: 'HTML', icon: Code },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'kpi', label: 'KPI', icon: BarChart2 },
  ];

  const meta = getStepMeta(step.step_type);
  const Icon = meta.icon;

  return (
    <div className="flex flex-col h-full bg-[#13151E] border-l border-[#2A2D3A]">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A2D3A]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${meta.color}22` }}>
            <Icon className="w-4 h-4" style={{ color: meta.color }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">{step.name}</h3>
            <p className="text-xs text-gray-500 capitalize">{step.step_type} · Step {step.step_number}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {step.live_url && (
            <a href={step.live_url} target="_blank" rel="noopener noreferrer"
              className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors" title="Open live URL">
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          <button onClick={() => { if (confirm('Delete this step?')) onDelete(); }}
            className="p-1.5 text-gray-400 hover:text-red-400 transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2A2D3A]">
        {tabs.map(t => {
          const TIcon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors flex-1 justify-center
                ${tab === t.id ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <TIcon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'copy' && (
          <div className="h-full flex flex-col gap-3">
            <label className="text-xs font-medium text-gray-400">Copy / VSL Script</label>
            <textarea
              value={localStep.copy_text || ''}
              onChange={e => updateLocal('copy_text', e.target.value)}
              placeholder="Paste your copy, VSL script, or page text here..."
              className="flex-1 min-h-[300px] w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none font-mono"
            />
          </div>
        )}

        {tab === 'html' && (
          <div className="h-full flex flex-col gap-3">
            <label className="text-xs font-medium text-gray-400">HTML Content</label>
            <textarea
              value={localStep.html_content || ''}
              onChange={e => updateLocal('html_content', e.target.value)}
              placeholder="Paste full page HTML here..."
              className="flex-1 min-h-[300px] w-full px-3 py-2 bg-[#0A0B10] border border-[#2A2D3A] rounded-lg text-xs text-green-400 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none font-mono leading-relaxed"
            />
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Step Name</label>
              <input
                type="text"
                value={localStep.name}
                onChange={e => updateLocal('name', e.target.value)}
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Step Type</label>
              <select
                value={localStep.step_type}
                onChange={e => updateLocal('step_type', e.target.value)}
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {STEP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Status</label>
              <select
                value={localStep.status}
                onChange={e => updateLocal('status', e.target.value)}
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="draft">Draft</option>
                <option value="ready">Ready</option>
                <option value="live">Live</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Live URL</label>
              <input
                type="text"
                value={localStep.live_url || ''}
                onChange={e => updateLocal('live_url', e.target.value)}
                placeholder="https://..."
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Price ($)</label>
              <input
                type="number"
                value={localStep.price ?? ''}
                onChange={e => updateLocal('price', e.target.value ? parseFloat(e.target.value) : null)}
                placeholder="0.00"
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Offer Type</label>
              <select
                value={localStep.offer_type || ''}
                onChange={e => updateLocal('offer_type', e.target.value || null)}
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select...</option>
                <option value="fe">Front End (FE)</option>
                <option value="bump">Order Bump</option>
                <option value="oto">One-Time Offer (OTO)</option>
                <option value="downsell">Downsell</option>
                <option value="free">Free</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Preview Image URL</label>
              <input
                type="text"
                value={localStep.preview_image || ''}
                onChange={e => updateLocal('preview_image', e.target.value)}
                placeholder="https://..."
                className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {tab === 'kpi' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-[#0F1117] rounded-xl p-3 border border-[#2A2D3A]">
                <p className="text-xs text-gray-500 mb-1">Visits</p>
                <p className="text-2xl font-bold text-white">{localStep.visits?.toLocaleString() || 0}</p>
              </div>
              <div className="bg-[#0F1117] rounded-xl p-3 border border-[#2A2D3A]">
                <p className="text-xs text-gray-500 mb-1">Conversions</p>
                <p className="text-2xl font-bold text-green-400">{localStep.conversions?.toLocaleString() || 0}</p>
              </div>
              <div className="bg-[#0F1117] rounded-xl p-3 border border-[#2A2D3A]">
                <p className="text-xs text-gray-500 mb-1">CVR %</p>
                <p className="text-2xl font-bold text-blue-400">{localStep.cvr || 0}%</p>
              </div>
              <div className="bg-[#0F1117] rounded-xl p-3 border border-[#2A2D3A]">
                <p className="text-xs text-gray-500 mb-1">Revenue</p>
                <p className="text-2xl font-bold text-yellow-400">${(localStep.revenue || 0).toLocaleString()}</p>
              </div>
            </div>
            <div className="space-y-3 mt-4">
              <label className="text-xs font-medium text-gray-400 block">Update KPIs manually</label>
              {[
                { key: 'visits' as keyof FlowStep, label: 'Visits', type: 'number' },
                { key: 'conversions' as keyof FlowStep, label: 'Conversions', type: 'number' },
                { key: 'cvr' as keyof FlowStep, label: 'CVR (%)', type: 'number' },
                { key: 'revenue' as keyof FlowStep, label: 'Revenue ($)', type: 'number' },
              ].map(field => (
                <div key={field.key}>
                  <label className="text-xs text-gray-500 block mb-1">{field.label}</label>
                  <input
                    type={field.type}
                    value={(localStep[field.key] as number) ?? 0}
                    onChange={e => updateLocal(field.key, parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="px-4 py-3 border-t border-[#2A2D3A]">
        <button
          onClick={save}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          <Check className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

/* ─── Add Step Modal ─── */
function AddStepModal({ onAdd, onClose }: {
  onAdd: (type: string, name: string) => void;
  onClose: () => void;
}) {
  const [selectedType, setSelectedType] = useState('');
  const [name, setName] = useState('');

  function handleAdd() {
    if (!selectedType) return;
    const meta = getStepMeta(selectedType);
    onAdd(selectedType, name.trim() || meta.label);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#1A1D27] border border-[#2A2D3A] rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2A2D3A]">
          <h3 className="text-white font-semibold">Add Step</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-2">Step Type</label>
            <div className="grid grid-cols-3 gap-2">
              {STEP_TYPES.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.value}
                    onClick={() => { setSelectedType(t.value); setName(t.label); }}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-xs font-medium
                      ${selectedType === t.value
                        ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                        : 'border-[#2A2D3A] text-gray-400 hover:border-[#3A3D4A] hover:text-gray-300'
                      }`}
                  >
                    <Icon className="w-5 h-5" style={{ color: selectedType === t.value ? t.color : undefined }} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">Step Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Main VSL, Order Page..."
              className="w-full px-3 py-2 bg-[#0F1117] border border-[#2A2D3A] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-[#2A2D3A] text-gray-400 text-sm rounded-lg hover:bg-[#252836] transition-colors">
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!selectedType}
            className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-40"
          >
            Add Step
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main Page ─── */
export default function FlowPage({ params }: { params: Promise<{ id: string; flowId: string }> }) {
  const { id: projectId, flowId } = use(params);
  const router = useRouter();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStep, setSelectedStep] = useState<FlowStep | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    loadFlow();
  }, [flowId]);

  async function loadFlow() {
    setLoading(true);
    const [flowRes, stepsRes] = await Promise.all([
      supabase.from('funnel_flows').select('*').eq('id', flowId).single(),
      supabase.from('flow_steps').select('*').eq('flow_id', flowId).order('step_number', { ascending: true }),
    ]);
    if (flowRes.data) setFlow(flowRes.data);
    if (stepsRes.data) setSteps(stepsRes.data);
    setLoading(false);
  }

  async function addStep(stepType: string, name: string) {
    const nextNumber = steps.length > 0 ? Math.max(...steps.map(s => s.step_number)) + 1 : 1;
    const { data, error } = await supabase.from('flow_steps').insert({
      flow_id: flowId,
      project_id: projectId,
      step_number: nextNumber,
      step_type: stepType,
      name,
      status: 'draft',
    }).select().single();
    if (!error && data) {
      setSteps(prev => [...prev, data]);
    }
  }

  async function updateStep(updates: Partial<FlowStep>) {
    if (!selectedStep) return;
    const { data, error } = await supabase.from('flow_steps')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', selectedStep.id)
      .select().single();
    if (!error && data) {
      setSteps(prev => prev.map(s => s.id === data.id ? data : s));
      setSelectedStep(data);
    }
  }

  async function deleteStep(stepId: string) {
    const { error } = await supabase.from('flow_steps').delete().eq('id', stepId);
    if (!error) {
      setSteps(prev => prev.filter(s => s.id !== stepId));
      if (selectedStep?.id === stepId) setSelectedStep(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0F1117] flex items-center justify-center">
        <div className="text-gray-400 text-lg animate-pulse">Loading flow...</div>
      </div>
    );
  }

  const panelOpen = selectedStep !== null;

  return (
    <div className="min-h-screen bg-[#0F1117] flex flex-col">
      {/* Top Bar */}
      <div className="bg-[#13151E] border-b border-[#2A2D3A] px-6 py-3 flex items-center gap-4">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <div className="w-px h-5 bg-[#2A2D3A]" />
        <div className="flex-1">
          <h1 className="text-white font-semibold text-sm">{flow?.name || 'Funnel Flow'}</h1>
          <p className="text-gray-500 text-xs">{steps.length} step{steps.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
            flow?.status === 'live' ? 'bg-green-900 text-green-300' :
            flow?.status === 'paused' ? 'bg-yellow-900 text-yellow-300' :
            'bg-gray-800 text-gray-400'
          }`}>
            {flow?.status || 'draft'}
          </span>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Step
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Flow Canvas */}
        <div className={`flex-1 overflow-x-auto overflow-y-auto transition-all duration-300`}>
          <div className="min-h-full p-8 flex items-start">
            {steps.length === 0 ? (
              <div className="w-full flex flex-col items-center justify-center min-h-[400px] gap-4">
                <div className="w-16 h-16 rounded-2xl bg-[#1A1D27] border-2 border-dashed border-[#2A2D3A] flex items-center justify-center">
                  <Plus className="w-8 h-8 text-gray-600" />
                </div>
                <div className="text-center">
                  <h3 className="text-gray-400 font-medium">No steps yet</h3>
                  <p className="text-gray-600 text-sm mt-1">Click &quot;Add Step&quot; to build your funnel flow</p>
                </div>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add First Step
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-0 min-w-max">
                {steps.map((step, index) => (
                  <div key={step.id} className="flex items-center">
                    <StepCard
                      step={step}
                      onClick={() => setSelectedStep(selectedStep?.id === step.id ? null : step)}
                      isSelected={selectedStep?.id === step.id}
                    />
                    {index < steps.length - 1 && <Arrow />}
                  </div>
                ))}
                {/* Add Step at end */}
                <div className="flex items-center">
                  <Arrow />
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="flex-shrink-0 w-16 h-16 rounded-xl border-2 border-dashed border-[#2A2D3A] hover:border-blue-500 hover:bg-blue-500/5 flex items-center justify-center transition-all"
                  >
                    <Plus className="w-6 h-6 text-gray-600 hover:text-blue-400" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Side Panel */}
        {panelOpen && selectedStep && (
          <div className="w-80 flex-shrink-0 flex flex-col" style={{ minHeight: '100%' }}>
            <SidePanel
              step={selectedStep}
              onClose={() => setSelectedStep(null)}
              onUpdate={updateStep}
              onDelete={() => deleteStep(selectedStep.id)}
            />
          </div>
        )}
      </div>

      {/* Add Step Modal */}
      {showAddModal && (
        <AddStepModal
          onAdd={addStep}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
