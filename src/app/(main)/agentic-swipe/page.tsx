'use client';

import { useState, useRef, useCallback } from 'react';
import Header from '@/components/Header';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';
import {
  Sparkles,
  Loader2,
  Eye,
  Code,
  FileText,
  Target,
  Layers,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Download,
  Copy,
  Paintbrush,
  BarChart3,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  Zap,
  Brain,
  Search,
  Hammer,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ProgressEvent {
  type: 'progress';
  phase: string;
  message: string;
  progress: number;
}

interface ResultEvent {
  type: 'result';
  success: boolean;
  html: string;
  productAnalysis: Record<string, unknown>;
  landingAnalysis: Record<string, unknown>;
  croPlan: CROPlanData;
}

interface ErrorEvent {
  type: 'error';
  error: string;
}

type SSEEvent = ProgressEvent | ResultEvent | ErrorEvent;

interface CROSectionData {
  section_index: number;
  section_type: string;
  source_action: string;
  rationale: string;
  content: {
    headline: string;
    subheadline?: string;
    body_copy: string;
    cta_text?: string;
  };
  cro_elements: string[];
  mobile_notes: string;
}

interface CROPlanData {
  strategy_summary: string;
  primary_framework: string;
  estimated_conversion_lift: string;
  sections: CROSectionData[];
  above_fold_strategy: {
    primary_hook: string;
    value_proposition: string;
  };
  copy_tone: {
    voice: string;
    language: string;
    formality: string;
  };
}

// ── Pipeline Phase Configuration ─────────────────────────────────────────────

const PHASES = [
  { id: 'product_analysis', label: 'Product Analysis', icon: Brain, description: 'Understanding product, market, and audience' },
  { id: 'landing_analysis', label: 'Landing Analysis', icon: Search, description: 'Analyzing source page structure and design' },
  { id: 'cro_planning', label: 'CRO Strategy', icon: Target, description: 'Designing optimal conversion architecture' },
  { id: 'html_generation', label: 'HTML Builder', icon: Hammer, description: 'Building production-ready landing page' },
];

// ── Section Type Colors ──────────────────────────────────────────────────────

const SECTION_COLORS: Record<string, string> = {
  hero: 'bg-purple-100 text-purple-800 border-purple-300',
  social_proof_bar: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  problem_agitation: 'bg-red-100 text-red-800 border-red-300',
  solution_reveal: 'bg-green-100 text-green-800 border-green-300',
  benefits: 'bg-blue-100 text-blue-800 border-blue-300',
  how_it_works: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  testimonials: 'bg-amber-100 text-amber-800 border-amber-300',
  credibility: 'bg-teal-100 text-teal-800 border-teal-300',
  comparison: 'bg-orange-100 text-orange-800 border-orange-300',
  faq: 'bg-gray-100 text-gray-800 border-gray-300',
  guarantee: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  pricing: 'bg-violet-100 text-violet-800 border-violet-300',
  urgency: 'bg-rose-100 text-rose-800 border-rose-300',
  cta_block: 'bg-pink-100 text-pink-800 border-pink-300',
  bonus_stack: 'bg-lime-100 text-lime-800 border-lime-300',
  risk_reversal: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  story: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
  stats_counter: 'bg-sky-100 text-sky-800 border-sky-300',
  video_section: 'bg-slate-100 text-slate-800 border-slate-300',
  footer: 'bg-neutral-100 text-neutral-800 border-neutral-300',
};

function getSectionColor(type: string): string {
  return SECTION_COLORS[type] || 'bg-gray-100 text-gray-800 border-gray-300';
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AgenticSwipePage() {
  // Form state
  const [url, setUrl] = useState('');
  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [target, setTarget] = useState('');
  const [priceInfo, setPriceInfo] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');

  // Pipeline state
  const [isRunning, setIsRunning] = useState(false);
  const [currentPhase, setCurrentPhase] = useState('');
  const [currentMessage, setCurrentMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [completedPhases, setCompletedPhases] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  // Results state
  const [resultHtml, setResultHtml] = useState('');
  const [productAnalysis, setProductAnalysis] = useState<Record<string, unknown> | null>(null);
  const [landingAnalysis, setLandingAnalysis] = useState<Record<string, unknown> | null>(null);
  const [croPlan, setCroPlan] = useState<CROPlanData | null>(null);

  // UI state
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'editor' | 'report'>('preview');
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ── Run Pipeline ───────────────────────────────────────────────────────────

  const runPipeline = useCallback(async () => {
    if (!url || !productName || !productDescription) return;

    setIsRunning(true);
    setError('');
    setResultHtml('');
    setProductAnalysis(null);
    setLandingAnalysis(null);
    setCroPlan(null);
    setCurrentPhase('starting');
    setCurrentMessage('Initializing agentic swipe pipeline...');
    setProgress(0);
    setCompletedPhases(new Set());

    abortRef.current = new AbortController();

    try {
      const response = await fetch('/api/agentic-swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          productName,
          productDescription,
          target: target || undefined,
          priceInfo: priceInfo || undefined,
          customInstructions: customInstructions || undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error((errData as Record<string, string>).error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent;

            if (event.type === 'progress') {
              setCurrentPhase(event.phase);
              setCurrentMessage(event.message);
              setProgress(event.progress);

              // Track completed phases
              if (event.phase.endsWith('_complete') || event.message.toLowerCase().includes('complete')) {
                const basePhase = event.phase.replace('_complete', '');
                setCompletedPhases((prev) => new Set([...prev, basePhase]));
              }
              if (event.phase === 'phase1_complete') {
                setCompletedPhases((prev) => new Set([...prev, 'product_analysis', 'landing_analysis']));
              }
              if (event.phase === 'phase2_complete') {
                setCompletedPhases((prev) => new Set([...prev, 'cro_planning']));
              }
            }

            if (event.type === 'result' && event.success) {
              setResultHtml(event.html);
              setProductAnalysis(event.productAnalysis);
              setLandingAnalysis(event.landingAnalysis);
              setCroPlan(event.croPlan);
              setCompletedPhases(new Set(['product_analysis', 'landing_analysis', 'cro_planning', 'html_generation']));
              setProgress(100);
              setCurrentMessage('Agentic swipe complete!');
              setActiveTab('preview');
            }

            if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setCurrentMessage('Pipeline cancelled');
      } else {
        setError((err as Error).message || 'Unknown error');
        setCurrentMessage('Pipeline failed');
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }, [url, productName, productDescription, target, priceInfo, customInstructions]);

  const cancelPipeline = () => {
    abortRef.current?.abort();
  };

  const toggleSection = (idx: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const copyHtml = () => {
    navigator.clipboard.writeText(resultHtml);
  };

  const downloadHtml = () => {
    const blob = new Blob([resultHtml], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${productName.replace(/\s+/g, '-').toLowerCase()}-landing.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const hasResult = resultHtml.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="Agentic Swipe" subtitle="AI-powered landing page transformation" />

      <div className="max-w-[1600px] mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* ── Left Panel: Input Form + Progress ──────────────────────── */}
          <div className="lg:col-span-4 space-y-4">
            {/* Input Form */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-5 h-5 text-purple-500" />
                <h2 className="text-lg font-semibold text-gray-900">Swipe Configuration</h2>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Landing Page URL *
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://competitor-landing.com/offer"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    disabled={isRunning}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your Product Name *
                  </label>
                  <input
                    type="text"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="e.g. GlucoPure Pro"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    disabled={isRunning}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Product Description *
                  </label>
                  <textarea
                    value={productDescription}
                    onChange={(e) => setProductDescription(e.target.value)}
                    placeholder="Describe your product, its benefits, unique mechanism, what makes it different..."
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none"
                    disabled={isRunning}
                  />
                </div>

                {/* Advanced Fields */}
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-sm text-purple-600 hover:text-purple-700"
                >
                  {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  Advanced Options
                </button>

                {showAdvanced && (
                  <div className="space-y-3 pt-1">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Audience
                      </label>
                      <input
                        type="text"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        placeholder="e.g. Women 40-65 with blood sugar concerns"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        disabled={isRunning}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Price Info
                      </label>
                      <input
                        type="text"
                        value={priceInfo}
                        onChange={(e) => setPriceInfo(e.target.value)}
                        placeholder="e.g. $49.99 (was $99) - 3 bottle pack"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        disabled={isRunning}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Custom Instructions
                      </label>
                      <textarea
                        value={customInstructions}
                        onChange={(e) => setCustomInstructions(e.target.value)}
                        placeholder="Any specific instructions: tone, language, elements to include/exclude..."
                        rows={2}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none"
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                )}

                {/* Action Button */}
                <div className="pt-2">
                  {isRunning ? (
                    <button
                      onClick={cancelPipeline}
                      className="w-full py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                    >
                      <AlertCircle className="w-4 h-4" />
                      Cancel Pipeline
                    </button>
                  ) : (
                    <button
                      onClick={runPipeline}
                      disabled={!url || !productName || !productDescription}
                      className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-500 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all shadow-md hover:shadow-lg disabled:shadow-none"
                    >
                      <Zap className="w-4 h-4" />
                      Run Agentic Swipe
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Pipeline Progress */}
            {(isRunning || hasResult || error) && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Layers className="w-5 h-5 text-indigo-500" />
                  <h3 className="text-sm font-semibold text-gray-900">Pipeline Progress</h3>
                  <span className="ml-auto text-xs font-medium text-gray-500">{Math.round(progress)}%</span>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-gray-200 rounded-full h-2 mb-4">
                  <div
                    className="bg-gradient-to-r from-purple-500 to-indigo-500 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>

                {/* Phase Steps */}
                <div className="space-y-2">
                  {PHASES.map((phase) => {
                    const isCompleted = completedPhases.has(phase.id);
                    const isActive =
                      currentPhase === phase.id ||
                      currentPhase.startsWith(phase.id);
                    const Icon = phase.icon;

                    return (
                      <div
                        key={phase.id}
                        className={`flex items-start gap-3 p-2.5 rounded-lg transition-colors ${
                          isActive && !isCompleted
                            ? 'bg-purple-50 border border-purple-200'
                            : isCompleted
                            ? 'bg-green-50 border border-green-200'
                            : 'bg-gray-50 border border-transparent'
                        }`}
                      >
                        <div className="mt-0.5">
                          {isCompleted ? (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                          ) : isActive ? (
                            <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />
                          ) : (
                            <Icon className="w-4 h-4 text-gray-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              isCompleted
                                ? 'text-green-700'
                                : isActive
                                ? 'text-purple-700'
                                : 'text-gray-500'
                            }`}
                          >
                            {phase.label}
                          </p>
                          <p className="text-xs text-gray-500 truncate">
                            {isActive && currentMessage ? currentMessage : phase.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {error && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-sm text-red-700 font-medium flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4" />
                      Error
                    </p>
                    <p className="text-xs text-red-600 mt-1">{error}</p>
                  </div>
                )}
              </div>
            )}

            {/* CRO Report (when complete) */}
            {croPlan && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart3 className="w-5 h-5 text-emerald-500" />
                  <h3 className="text-sm font-semibold text-gray-900">CRO Strategy Report</h3>
                </div>

                <div className="space-y-3">
                  <div className="p-3 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg border border-purple-100">
                    <p className="text-xs font-medium text-purple-700 mb-1">Strategy</p>
                    <p className="text-sm text-gray-800">{croPlan.strategy_summary}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 bg-blue-50 rounded-lg border border-blue-100">
                      <p className="text-xs text-blue-600 font-medium">Framework</p>
                      <p className="text-sm font-semibold text-blue-800">{croPlan.primary_framework}</p>
                    </div>
                    <div className="p-2.5 bg-green-50 rounded-lg border border-green-100">
                      <p className="text-xs text-green-600 font-medium">Language</p>
                      <p className="text-sm font-semibold text-green-800">{croPlan.copy_tone?.language?.toUpperCase() || 'EN'}</p>
                    </div>
                  </div>

                  {croPlan.above_fold_strategy && (
                    <div className="p-3 bg-amber-50 rounded-lg border border-amber-100">
                      <p className="text-xs font-medium text-amber-700 mb-1">
                        <Lightbulb className="w-3 h-3 inline mr-1" />
                        Above-the-Fold Hook
                      </p>
                      <p className="text-sm text-gray-800">{croPlan.above_fold_strategy.primary_hook}</p>
                    </div>
                  )}

                  {/* Section Map */}
                  <div>
                    <p className="text-xs font-medium text-gray-600 mb-2">
                      Section Blueprint ({croPlan.sections?.length || 0} sections)
                    </p>
                    <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                      {croPlan.sections?.map((section, idx) => (
                        <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
                          <button
                            onClick={() => toggleSection(idx)}
                            className="w-full flex items-center gap-2 p-2.5 hover:bg-gray-50 transition-colors text-left"
                          >
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${getSectionColor(section.section_type)}`}>
                              {section.section_type}
                            </span>
                            <span className="text-xs text-gray-600 flex-1 truncate">
                              {section.content?.headline || section.rationale}
                            </span>
                            <span className="text-xs text-gray-400">{section.source_action}</span>
                            {expandedSections.has(idx) ? (
                              <ChevronUp className="w-3 h-3 text-gray-400" />
                            ) : (
                              <ChevronDown className="w-3 h-3 text-gray-400" />
                            )}
                          </button>

                          {expandedSections.has(idx) && (
                            <div className="px-3 pb-3 space-y-2 border-t border-gray-100 pt-2">
                              <p className="text-xs text-gray-500 italic">{section.rationale}</p>
                              {section.content?.headline && (
                                <p className="text-sm font-semibold text-gray-800">{section.content.headline}</p>
                              )}
                              {section.content?.subheadline && (
                                <p className="text-xs text-gray-600">{section.content.subheadline}</p>
                              )}
                              {section.cro_elements?.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {section.cro_elements.map((el, i) => (
                                    <span key={i} className="text-xs px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">
                                      {el}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {section.mobile_notes && (
                                <p className="text-xs text-gray-400">Mobile: {section.mobile_notes}</p>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Right Panel: Results ──────────────────────────────────── */}
          <div className="lg:col-span-8">
            {!hasResult && !isRunning ? (
              /* Empty State */
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-[calc(100vh-160px)] flex items-center justify-center">
                <div className="text-center max-w-md px-6">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-100 to-indigo-100 flex items-center justify-center mx-auto mb-4">
                    <Sparkles className="w-8 h-8 text-purple-500" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Agentic Swipe Technology</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    A 4-agent AI pipeline that deeply analyzes your product and the source landing page,
                    then creates a CRO-optimized landing page with proper UX structure.
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-left">
                    {PHASES.map((phase) => {
                      const Icon = phase.icon;
                      return (
                        <div key={phase.id} className="flex items-start gap-2 p-3 bg-gray-50 rounded-lg">
                          <Icon className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-gray-700">{phase.label}</p>
                            <p className="text-xs text-gray-400">{phase.description}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-1 text-xs text-gray-400">
                    <ArrowRight className="w-3 h-3" />
                    Fill in the form and click &quot;Run Agentic Swipe&quot; to start
                  </div>
                </div>
              </div>
            ) : (
              /* Results View */
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                {/* Tab Bar */}
                <div className="border-b border-gray-200 px-4 flex items-center justify-between">
                  <div className="flex gap-1">
                    {[
                      { id: 'preview' as const, label: 'Preview', icon: Eye },
                      { id: 'code' as const, label: 'HTML Code', icon: Code },
                      { id: 'editor' as const, label: 'Visual Editor', icon: Paintbrush },
                      { id: 'report' as const, label: 'Full Report', icon: FileText },
                    ].map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          disabled={!hasResult}
                          className={`flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors ${
                            activeTab === tab.id
                              ? 'border-purple-500 text-purple-600'
                              : 'border-transparent text-gray-500 hover:text-gray-700'
                          } disabled:opacity-40`}
                        >
                          <Icon className="w-4 h-4" />
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>

                  {hasResult && (
                    <div className="flex gap-2">
                      <button
                        onClick={copyHtml}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        Copy
                      </button>
                      <button
                        onClick={downloadHtml}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download
                      </button>
                    </div>
                  )}
                </div>

                {/* Tab Content */}
                <div className="h-[calc(100vh-220px)]">
                  {activeTab === 'preview' && (
                    <div className="h-full">
                      {hasResult ? (
                        <iframe
                          srcDoc={resultHtml}
                          className="w-full h-full border-0"
                          sandbox="allow-scripts allow-same-origin"
                          title="Swiped Landing Preview"
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full">
                          <div className="text-center">
                            <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-3" />
                            <p className="text-sm text-gray-500">{currentMessage || 'Processing...'}</p>
                            <div className="w-48 bg-gray-200 rounded-full h-1.5 mt-3 mx-auto">
                              <div
                                className="bg-purple-500 h-1.5 rounded-full transition-all duration-500"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'code' && hasResult && (
                    <div className="h-full overflow-auto p-4">
                      <pre className="text-xs font-mono text-gray-800 whitespace-pre-wrap break-words">
                        {resultHtml}
                      </pre>
                    </div>
                  )}

                  {activeTab === 'editor' && hasResult && (
                    <div className="h-full">
                      <VisualHtmlEditor
                        initialHtml={resultHtml}
                        onSave={(html: string) => setResultHtml(html)}
                        onClose={() => setActiveTab('preview')}
                        pageTitle={productName || 'Swiped Landing'}
                      />
                    </div>
                  )}

                  {activeTab === 'report' && hasResult && (
                    <div className="h-full overflow-auto p-6 space-y-6">
                      {/* Product Analysis */}
                      {productAnalysis && (
                        <div>
                          <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                            <Brain className="w-5 h-5 text-purple-500" />
                            Product Analysis
                          </h3>
                          <pre className="text-xs font-mono bg-gray-50 p-4 rounded-lg overflow-auto max-h-[400px] border border-gray-200">
                            {JSON.stringify(productAnalysis, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* Landing Analysis */}
                      {landingAnalysis && (
                        <div>
                          <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                            <Search className="w-5 h-5 text-blue-500" />
                            Landing Page Analysis
                          </h3>
                          <pre className="text-xs font-mono bg-gray-50 p-4 rounded-lg overflow-auto max-h-[400px] border border-gray-200">
                            {JSON.stringify(landingAnalysis, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* CRO Plan */}
                      {croPlan && (
                        <div>
                          <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                            <Target className="w-5 h-5 text-emerald-500" />
                            CRO Blueprint
                          </h3>
                          <pre className="text-xs font-mono bg-gray-50 p-4 rounded-lg overflow-auto max-h-[400px] border border-gray-200">
                            {JSON.stringify(croPlan, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
