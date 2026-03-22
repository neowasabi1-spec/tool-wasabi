'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import type {
  AffiliateBrowserJob,
  AffiliateChatMessage,
} from '@/types';
import { AFFILIATE_JOB_FINISHED_STATUSES } from '@/types';
import {
  AFFILIATE_PROMPT_TEMPLATES,
  PROMPT_CATEGORIES,
  type AffiliatePromptTemplate,
  type PromptCategory,
} from '@/lib/affiliate-prompt-templates';
import type { ScheduledBrowserJob } from '@/types/database';
import {
  Send,
  Loader2,
  CheckCircle,
  XCircle,
  ExternalLink,
  Bot,
  User,
  AlertCircle,
  StopCircle,
  Globe,
  Zap,
  Eye,
  Clock,
  Activity,
  Wifi,
  WifiOff,
  Copy,
  RotateCcw,
  Settings2,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Save,
  Database,
  Tag,
  Search,
  TrendingUp,
  Target,
  FileText,
  Play,
  Pause,
  CalendarClock,
  Trash2,
  Sparkles,
  LayoutGrid,
  List,
  X,
  Timer,
  Power,
  PowerOff,
} from 'lucide-react';

// =====================================================
// HELPERS
// =====================================================

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function formatStatus(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case 'queued':
      return { label: 'Queued', color: 'bg-gray-100 text-gray-700', icon: <Clock className="w-3.5 h-3.5" /> };
    case 'starting':
      return { label: 'Starting browser...', color: 'bg-yellow-100 text-yellow-700', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> };
    case 'running':
      return { label: 'Running', color: 'bg-blue-100 text-blue-700', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> };
    case 'completed':
      return { label: 'Completed', color: 'bg-green-100 text-green-700', icon: <CheckCircle className="w-3.5 h-3.5" /> };
    case 'max_turns':
      return { label: 'Max turns reached', color: 'bg-orange-100 text-orange-700', icon: <AlertCircle className="w-3.5 h-3.5" /> };
    case 'blocked':
      return { label: 'Blocked', color: 'bg-red-100 text-red-700', icon: <XCircle className="w-3.5 h-3.5" /> };
    case 'error':
      return { label: 'Error', color: 'bg-red-100 text-red-700', icon: <XCircle className="w-3.5 h-3.5" /> };
    default:
      return { label: status, color: 'bg-gray-100 text-gray-700', icon: <Activity className="w-3.5 h-3.5" /> };
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function getCategoryIcon(category: PromptCategory) {
  switch (category) {
    case 'spy_ads': return <Search className="w-4 h-4" />;
    case 'competitor_analysis': return <Target className="w-4 h-4" />;
    case 'trends': return <TrendingUp className="w-4 h-4" />;
    case 'funnel_analysis': return <Eye className="w-4 h-4" />;
    case 'content_research': return <FileText className="w-4 h-4" />;
    case 'offer_discovery': return <Sparkles className="w-4 h-4" />;
    default: return <Zap className="w-4 h-4" />;
  }
}

function formatFrequency(freq: string): string {
  switch (freq) {
    case 'daily': return 'Daily';
    case 'weekly': return 'Weekly';
    case 'bi_weekly': return 'Every 2 weeks';
    case 'monthly': return 'Monthly';
    default: return freq;
  }
}

// =====================================================
// TABS
// =====================================================
type TabId = 'chat' | 'templates' | 'scheduled';

// =====================================================
// MAIN PAGE
// =====================================================

export default function AffiliateBrowserChatPage() {
  // --- Tab ---
  const [activeTab, setActiveTab] = useState<TabId>('chat');

  // --- Chat State ---
  const [prompt, setPrompt] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [maxTurns, setMaxTurns] = useState(100);
  const [showSettings, setShowSettings] = useState(false);

  const [messages, setMessages] = useState<AffiliateChatMessage[]>([]);
  const [job, setJob] = useState<AffiliateBrowserJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // OpenClaw mode
  const [useOpenClaw, setUseOpenClaw] = useState(false);
  const [openClawOnline, setOpenClawOnline] = useState<boolean | null>(null);
  const [openClawHistory, setOpenClawHistory] = useState<{ role: string; content: string }[]>([]);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // --- Template State ---
  const [selectedCategory, setSelectedCategory] = useState<PromptCategory | 'all'>('all');
  const [templateSearch, setTemplateSearch] = useState('');

  // --- Schedule State ---
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledBrowserJob[]>([]);
  const [loadingScheduled, setLoadingScheduled] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleTemplate, setScheduleTemplate] = useState<AffiliatePromptTemplate | null>(null);
  const [scheduleFrequency, setScheduleFrequency] = useState<string>('daily');
  const [schedulingInProgress, setSchedulingInProgress] = useState(false);

  // --- Auto-scroll chat ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- Health check on mount ---
  useEffect(() => {
    checkHealth();
  }, []);

  // --- Load scheduled jobs when tab changes ---
  useEffect(() => {
    if (activeTab === 'scheduled') {
      loadScheduledJobs();
    }
  }, [activeTab]);

  const checkHealth = async () => {
    try {
      const res = await fetch('/api/affiliate-browser-chat/health');
      const data = await res.json();
      setServerOnline(data.success && data.agenticServer === 'online');
    } catch {
      setServerOnline(false);
    }
    try {
      const res = await fetch('/api/openclaw/chat');
      const data = await res.json();
      setOpenClawOnline(data.status === 'online');
    } catch {
      setOpenClawOnline(false);
    }
  };

  const loadScheduledJobs = async () => {
    setLoadingScheduled(true);
    try {
      const res = await fetch('/api/scheduled-jobs');
      const data = await res.json();
      if (data.success) {
        setScheduledJobs(data.jobs);
      }
    } catch {
      // ignore
    } finally {
      setLoadingScheduled(false);
    }
  };

  // --- Add message ---
  const addMessage = useCallback((role: AffiliateChatMessage['role'], content: string, turnNumber?: number) => {
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role,
        content,
        timestamp: new Date(),
        turnNumber,
      },
    ]);
  }, []);

  // --- Stop polling ---
  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // --- Start agent ---
  const startAgent = async (customPrompt?: string, customStartUrl?: string, customMaxTurns?: number) => {
    const trimmedPrompt = (customPrompt || prompt).trim();
    if (!trimmedPrompt) return;

    const effectiveStartUrl = customStartUrl ?? startUrl;
    const effectiveMaxTurns = customMaxTurns ?? maxTurns;

    setActiveTab('chat');
    setIsRunning(true);
    setJob(null);
    setJobId(null);

    addMessage('user', trimmedPrompt);
    if (!customPrompt) setPrompt('');

    const urlLabel = effectiveStartUrl.trim() ? effectiveStartUrl.trim() : 'Google (default)';
    addMessage('system', `Starting browser agent on ${urlLabel} with max ${effectiveMaxTurns} turns...`);

    try {
      const res = await fetch('/api/affiliate-browser-chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          startUrl: effectiveStartUrl.trim() || undefined,
          maxTurns: effectiveMaxTurns,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        addMessage('system', `Error: ${data.error}`);
        setIsRunning(false);
        return;
      }

      setJobId(data.jobId);
      addMessage('system', `Job started (${data.jobId.slice(0, 8)}...). Monitoring in progress...`);

      startPolling(data.jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      addMessage('system', `Connection error: ${msg}`);
      setIsRunning(false);
    }
  };

  // --- OpenClaw chat ---
  const sendToOpenClaw = async (customPrompt?: string) => {
    const trimmedPrompt = (customPrompt || prompt).trim();
    if (!trimmedPrompt) return;

    setActiveTab('chat');
    setIsRunning(true);

    addMessage('user', trimmedPrompt);
    if (!customPrompt) setPrompt('');

    const urlContext = startUrl.trim() ? `\n\nNavigate and analyze this URL: ${startUrl.trim()}` : '';
    const userMsg = { role: 'user', content: trimmedPrompt + urlContext };
    const history = [...openClawHistory, userMsg];

    addMessage('system', 'Sending to OpenClaw...');

    try {
      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      const data = await res.json();

      if (data.error) {
        addMessage('system', `OpenClaw error: ${data.error}`);
      } else {
        const assistantMsg = { role: 'assistant', content: data.content };
        setOpenClawHistory([...history, assistantMsg]);
        addMessage('agent', data.content);
      }
    } catch (err) {
      addMessage('system', `OpenClaw connection failed: ${(err as Error).message}`);
    } finally {
      setIsRunning(false);
    }
  };

  // --- Use template ---
  const useTemplate = (template: AffiliatePromptTemplate) => {
    setPrompt(template.prompt);
    setStartUrl(template.startUrl);
    setMaxTurns(template.maxTurns);
    setActiveTab('chat');
    inputRef.current?.focus();
  };

  // --- Run template immediately ---
  const runTemplateNow = (template: AffiliatePromptTemplate) => {
    if (useOpenClaw) {
      setStartUrl(template.startUrl || '');
      sendToOpenClaw(template.prompt);
    } else {
      startAgent(template.prompt, template.startUrl, template.maxTurns);
    }
  };

  // --- Schedule a template ---
  const openScheduleModal = (template: AffiliatePromptTemplate) => {
    setScheduleTemplate(template);
    setScheduleFrequency(template.suggestedFrequency || 'daily');
    setScheduleModalOpen(true);
  };

  const confirmSchedule = async () => {
    if (!scheduleTemplate) return;
    setSchedulingInProgress(true);

    try {
      const res = await fetch('/api/scheduled-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: scheduleTemplate.id,
          title: scheduleTemplate.title,
          prompt: scheduleTemplate.prompt,
          startUrl: scheduleTemplate.startUrl || null,
          maxTurns: scheduleTemplate.maxTurns,
          category: scheduleTemplate.category,
          tags: scheduleTemplate.tags,
          frequency: scheduleFrequency,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setScheduleModalOpen(false);
        setScheduleTemplate(null);
        // Refresh scheduled list
        loadScheduledJobs();
        // Switch to scheduled tab to show confirmation
        setActiveTab('scheduled');
      }
    } catch {
      // ignore
    } finally {
      setSchedulingInProgress(false);
    }
  };

  // --- Toggle scheduled job ---
  const toggleJob = async (jobItem: ScheduledBrowserJob) => {
    try {
      await fetch('/api/scheduled-jobs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: jobItem.id,
          action: 'toggle',
          isActive: !jobItem.is_active,
        }),
      });
      loadScheduledJobs();
    } catch {
      // ignore
    }
  };

  // --- Delete scheduled job ---
  const deleteJob = async (id: string) => {
    try {
      await fetch(`/api/scheduled-jobs?id=${id}`, { method: 'DELETE' });
      loadScheduledJobs();
    } catch {
      // ignore
    }
  };

  // --- Polling ---
  const startPolling = (id: string) => {
    stopPolling();

    let lastText = '';
    let lastTurn = 0;

    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/affiliate-browser-chat/status?jobId=${id}`);
        const data = await res.json();

        if (!data.success) return;

        const j: AffiliateBrowserJob = data.job;
        setJob(j);

        if (j.lastText && j.lastText !== lastText) {
          lastText = j.lastText;
          setMessages((prev) => {
            const filtered = prev.filter(
              (m) => !(m.role === 'agent' && m.id === 'agent-thinking'),
            );
            return [
              ...filtered,
              {
                id: 'agent-thinking',
                role: 'agent' as const,
                content: j.lastText,
                timestamp: new Date(),
                turnNumber: j.currentTurn,
              },
            ];
          });
        }

        if (j.currentTurn > lastTurn) {
          lastTurn = j.currentTurn;
        }

        if (AFFILIATE_JOB_FINISHED_STATUSES.includes(j.status)) {
          stopPolling();
          setIsRunning(false);

          setMessages((prev) => prev.filter((m) => m.id !== 'agent-thinking'));

          if (j.result) {
            addMessage('agent', j.result);
          }
          if (j.error) {
            addMessage('system', `Error: ${j.error}`);
          }
          if (j.status === 'max_turns') {
            addMessage('system', `The agent has reached the limit of ${j.maxTurns} turns. The result may be partial.`);
          }
          if (j.status === 'blocked') {
            addMessage('system', 'Action blocked by security system.');
          }
        }
      } catch {
        // Network error during polling — keep trying
      }
    }, 3000);
  };

  // --- Stop agent ---
  const stopAgent = () => {
    stopPolling();
    setIsRunning(false);
    addMessage('system', 'Monitoring stopped by user.');
    if (jobId) {
      fetch(`/api/affiliate-browser-chat/stop?jobId=${jobId}`, { method: 'DELETE' }).catch(() => {});
    }
  };

  // --- Copy result ---
  const copyResult = () => {
    const agentMessages = messages.filter((m) => m.role === 'agent' && m.id !== 'agent-thinking');
    const lastAgent = agentMessages[agentMessages.length - 1];
    if (lastAgent) {
      navigator.clipboard.writeText(lastAgent.content);
    }
  };

  // --- Detect save commands ---
  const parseSaveCommand = (text: string): { isSave: boolean; saveType: 'quiz' | 'funnel' } | null => {
    const lower = text.trim().toLowerCase();
    if (/^salva\s+quiz/.test(lower)) return { isSave: true, saveType: 'quiz' };
    if (/^salva\s+funnel/.test(lower)) return { isSave: true, saveType: 'funnel' };
    if (/^save\s+quiz/.test(lower)) return { isSave: true, saveType: 'quiz' };
    if (/^save\s+funnel/.test(lower)) return { isSave: true, saveType: 'funnel' };
    return null;
  };

  // --- Get last agent result ---
  const getLastAgentResult = (): string | null => {
    const agentMessages = messages.filter((m) => m.role === 'agent' && m.id !== 'agent-thinking');
    const lastAgent = agentMessages[agentMessages.length - 1];
    return lastAgent?.content ?? null;
  };

  // --- Save funnel via Claude ---
  const saveFunnel = async (saveType: 'quiz' | 'funnel') => {
    const agentResult = getLastAgentResult();
    if (!agentResult) {
      addMessage('system', 'No agent result available to save. Run an analysis first.');
      return;
    }

    setIsSaving(true);
    const typeLabel = saveType === 'quiz' ? 'Quiz Funnel' : 'Funnel';
    addMessage('system', `Analyzing result with Claude AI to save as ${typeLabel}...`);

    try {
      const res = await fetch('/api/affiliate-browser-chat/save-funnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentResult,
          jobId: jobId || undefined,
          saveType,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        addMessage('system', `Save error: ${data.error}`);
        setIsSaving(false);
        return;
      }

      const f = data.funnel;
      const savedMsg = [
        `Funnel saved successfully!`,
        ``,
        `Name: ${f.funnel_name}`,
        f.brand_name ? `Brand: ${f.brand_name}` : null,
        `Type: ${f.funnel_type}`,
        `Category: ${f.category}`,
        `Total steps: ${f.total_steps}`,
        f.tags?.length > 0 ? `Tags: ${f.tags.join(', ')}` : null,
        ``,
        f.analysis_summary ? `Analysis: ${f.analysis_summary}` : null,
      ].filter(Boolean).join('\n');

      addMessage('agent', savedMsg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      addMessage('system', `Connection error during save: ${msg}`);
    } finally {
      setIsSaving(false);
    }
  };

  // --- Handle submit (agent or save command) ---
  const handleSubmit = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const saveCmd = parseSaveCommand(trimmedPrompt);
    if (saveCmd) {
      addMessage('user', trimmedPrompt);
      setPrompt('');
      saveFunnel(saveCmd.saveType);
    } else if (useOpenClaw) {
      sendToOpenClaw();
    } else {
      startAgent();
    }
  };

  // --- Handle Enter ---
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isRunning && !isSaving && prompt.trim()) {
        handleSubmit();
      }
    }
  };

  // --- Cleanup ---
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // --- Filter templates ---
  const filteredTemplates = AFFILIATE_PROMPT_TEMPLATES.filter((t) => {
    const matchCategory = selectedCategory === 'all' || t.category === selectedCategory;
    const matchSearch = !templateSearch || 
      t.title.toLowerCase().includes(templateSearch.toLowerCase()) ||
      t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
      t.tags.some(tag => tag.toLowerCase().includes(templateSearch.toLowerCase()));
    return matchCategory && matchSearch;
  });

  // --- Render ---
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header
        title="Affiliate Browser Chat"
        subtitle="Prompt templates, browser agent and scheduled jobs for affiliate marketing"
      />

      <div className="flex-1 flex flex-col p-6 max-w-6xl mx-auto w-full">
        {/* Server status bar */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            {/* Engine toggle */}
            <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
              <button
                onClick={() => setUseOpenClaw(false)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  !useOpenClaw ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Bot className="w-3 h-3" /> Agentic Browser
                </span>
              </button>
              <button
                onClick={() => setUseOpenClaw(true)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  useOpenClaw ? 'bg-white text-orange-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Zap className="w-3 h-3" /> OpenClaw
                </span>
              </button>
            </div>

            {/* Status indicator */}
            {useOpenClaw ? (
              openClawOnline === null ? (
                <span className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Loader2 className="w-3 h-3 animate-spin" /> Checking OpenClaw...
                </span>
              ) : openClawOnline ? (
                <span className="flex items-center gap-1.5 text-xs text-green-600">
                  <Wifi className="w-3 h-3" /> OpenClaw online
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-red-500">
                  <WifiOff className="w-3 h-3" /> OpenClaw offline
                </span>
              )
            ) : (
              serverOnline === null ? (
                <span className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Loader2 className="w-3 h-3 animate-spin" /> Checking server...
                </span>
              ) : serverOnline ? (
                <span className="flex items-center gap-1.5 text-xs text-green-600">
                  <Wifi className="w-3 h-3" /> Agentic server online
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-red-500">
                  <WifiOff className="w-3 h-3" /> Agentic server offline
                </span>
              )
            )}
            <button
              onClick={checkHealth}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              title="Recheck"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Settings
            {showSettings ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 shadow-sm">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start URL</label>
                <input
                  type="url"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com (optional)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
                <p className="text-xs text-gray-400 mt-1">If empty, starts from Google</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Max agent turns</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={5}
                    max={500}
                    step={5}
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-sm font-mono bg-gray-100 px-2 py-1 rounded min-w-[3rem] text-center">
                    {maxTurns}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">More turns = deeper navigation (5-15 min per 100 turns)</p>
              </div>
            </div>
          </div>
        )}

        {/* Tab navigation */}
        <div className="flex items-center gap-1 mb-4 bg-white rounded-lg border border-gray-200 p-1 shadow-sm">
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all ${
              activeTab === 'chat'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            Chat
            {isRunning && (
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all ${
              activeTab === 'templates'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Prompt Templates
            <span className="text-xs opacity-70">({AFFILIATE_PROMPT_TEMPLATES.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('scheduled')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all ${
              activeTab === 'scheduled'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <CalendarClock className="w-4 h-4" />
            Scheduled
            {scheduledJobs.filter(j => j.is_active).length > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === 'scheduled' ? 'bg-white/20' : 'bg-blue-100 text-blue-700'
              }`}>
                {scheduledJobs.filter(j => j.is_active).length}
              </span>
            )}
          </button>
        </div>

        {/* =================== CHAT TAB =================== */}
        {activeTab === 'chat' && (
          <>
            {/* Live job status panel */}
            {job && isRunning && (
              <JobStatusPanel job={job} />
            )}

            {/* Chat messages */}
            <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                  <EmptyState onSelectTemplate={(t) => useTemplate(t)} />
                ) : (
                  messages.map((msg) => (
                    <ChatBubble key={msg.id} message={msg} />
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input area */}
              <div className="border-t border-gray-200 p-4 bg-gray-50">
                {!showSettings && startUrl && (
                  <div className="flex items-center gap-2 mb-2">
                    <Globe className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-xs text-gray-500 truncate">{startUrl}</span>
                    <a
                      href={startUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:text-blue-700"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}

                <div className="flex items-end gap-3">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      isRunning
                        ? "Agent running..."
                        : isSaving
                          ? "Saving in progress..."
                          : "Write the prompt... (or 'Save Quiz' / 'Save Funnel' to save the result)"
                    }
                    disabled={isRunning || isSaving}
                    rows={2}
                    className="flex-1 px-4 py-3 border border-gray-300 rounded-xl resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:bg-gray-100 disabled:text-gray-400 text-sm"
                  />

                  {isRunning ? (
                    <button
                      onClick={stopAgent}
                      className="flex items-center gap-2 px-5 py-3 bg-red-500 text-white rounded-xl hover:bg-red-600 transition-colors font-medium text-sm shrink-0"
                    >
                      <StopCircle className="w-4 h-4" />
                      Stop
                    </button>
                  ) : isSaving ? (
                    <button
                      disabled
                      className="flex items-center gap-2 px-5 py-3 bg-emerald-500 text-white rounded-xl font-medium text-sm shrink-0 cursor-not-allowed"
                    >
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </button>
                  ) : (
                    <button
                      onClick={handleSubmit}
                      disabled={!prompt.trim() || (!parseSaveCommand(prompt) && (useOpenClaw ? openClawOnline === false : serverOnline === false))}
                      className="flex items-center gap-2 px-5 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium text-sm shrink-0"
                    >
                      {parseSaveCommand(prompt) ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                      {parseSaveCommand(prompt) ? 'Save' : 'Send'}
                    </button>
                  )}
                </div>

                {/* Action buttons when result available */}
                {!isRunning && !isSaving && messages.some((m) => m.role === 'agent' && m.id !== 'agent-thinking') && (
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <button
                      onClick={copyResult}
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Copy className="w-3 h-3" />
                      Copy result
                    </button>
                    <span className="text-gray-200">|</span>
                    <button
                      onClick={() => {
                        addMessage('user', 'Save Quiz');
                        saveFunnel('quiz');
                      }}
                      className="flex items-center gap-1.5 text-xs text-emerald-500 hover:text-emerald-700 transition-colors font-medium"
                    >
                      <Database className="w-3 h-3" />
                      Save Quiz
                    </button>
                    <button
                      onClick={() => {
                        addMessage('user', 'Save Funnel');
                        saveFunnel('funnel');
                      }}
                      className="flex items-center gap-1.5 text-xs text-violet-500 hover:text-violet-700 transition-colors font-medium"
                    >
                      <Tag className="w-3 h-3" />
                      Save Funnel
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* =================== TEMPLATES TAB =================== */}
        {activeTab === 'templates' && (
          <div className="space-y-4">
            {/* Search & filter bar */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  placeholder="Search templates..."
                  className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-white"
                />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setSelectedCategory('all')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    selectedCategory === 'all'
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  All
                </button>
                {PROMPT_CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    onClick={() => setSelectedCategory(cat.value)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                      selectedCategory === cat.value
                        ? 'bg-gray-900 text-white'
                        : `${cat.bgColor} ${cat.color} hover:opacity-80`
                    }`}
                  >
                    {getCategoryIcon(cat.value)}
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Templates grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onUse={() => useTemplate(template)}
                  onRun={() => runTemplateNow(template)}
                  onSchedule={() => openScheduleModal(template)}
                  serverOnline={serverOnline === true}
                />
              ))}
            </div>

            {filteredTemplates.length === 0 && (
              <div className="text-center py-12">
                <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No template found</p>
                <p className="text-xs text-gray-400 mt-1">Try changing the search filters</p>
              </div>
            )}
          </div>
        )}

        {/* =================== SCHEDULED TAB =================== */}
        {activeTab === 'scheduled' && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Scheduled Jobs</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Jobs are executed automatically via the cron endpoint
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadScheduledJobs}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <RotateCcw className="w-3 h-3" />
                  Refresh
                </button>
                <button
                  onClick={() => setActiveTab('templates')}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                  Schedule new
                </button>
              </div>
            </div>

            {/* Info box about cron */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <Timer className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800">How scheduling works</p>
                  <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                    Scheduled jobs are executed automatically when the cron endpoint is called.
                    You can configure an external service (e.g. cron-job.org, Upstash, GitHub Actions) to call{' '}
                    <code className="bg-amber-100 px-1 py-0.5 rounded text-[10px] font-mono">GET /api/scheduled-jobs/cron</code>{' '}
                    at regular intervals (e.g. every hour). The system will check which jobs are &quot;due&quot; and execute them.
                  </p>
                </div>
              </div>
            </div>

            {/* Scheduled jobs list */}
            {loadingScheduled ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : scheduledJobs.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                <CalendarClock className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No scheduled jobs</p>
                <p className="text-xs text-gray-400 mt-1">
                  Go to <button onClick={() => setActiveTab('templates')} className="text-blue-500 hover:underline">Prompt Templates</button> to schedule a job
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {scheduledJobs.map((sj) => (
                  <ScheduledJobCard
                    key={sj.id}
                    job={sj}
                    onToggle={() => toggleJob(sj)}
                    onDelete={() => deleteJob(sj.id)}
                    onRunNow={() => {
                      startAgent(sj.prompt, sj.start_url || '', sj.max_turns);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* =================== SCHEDULE MODAL =================== */}
      {scheduleModalOpen && scheduleTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Schedule Job</h3>
                <button
                  onClick={() => setScheduleModalOpen(false)}
                  className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Template info */}
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <div className="flex items-center gap-2 mb-2">
                    {getCategoryIcon(scheduleTemplate.category)}
                    <span className="text-sm font-medium text-gray-900">{scheduleTemplate.title}</span>
                  </div>
                  <p className="text-xs text-gray-500">{scheduleTemplate.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    {scheduleTemplate.tags.map((tag) => (
                      <span key={tag} className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded text-[10px]">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Frequency selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Execution frequency</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['daily', 'weekly', 'bi_weekly', 'monthly'].map((freq) => (
                      <button
                        key={freq}
                        onClick={() => setScheduleFrequency(freq)}
                        className={`px-4 py-3 rounded-lg border text-sm font-medium transition-all ${
                          scheduleFrequency === freq
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <CalendarClock className="w-4 h-4" />
                          {formatFrequency(freq)}
                        </div>
                        {freq === 'daily' && <p className="text-[10px] text-gray-400 mt-1">Every day at 6:00 UTC</p>}
                        {freq === 'weekly' && <p className="text-[10px] text-gray-400 mt-1">Every 7 days</p>}
                        {freq === 'bi_weekly' && <p className="text-[10px] text-gray-400 mt-1">Every 14 days</p>}
                        {freq === 'monthly' && <p className="text-[10px] text-gray-400 mt-1">Every 30 days</p>}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Config summary */}
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                  <p className="text-xs text-blue-700">
                    The job will run <strong>{formatFrequency(scheduleFrequency).toLowerCase()}</strong> with{' '}
                    <strong>{scheduleTemplate.maxTurns} max turns</strong>
                    {scheduleTemplate.startUrl && (
                      <> starting from <strong>{scheduleTemplate.startUrl}</strong></>
                    )}
                    . The first execution will happen at the next cron cycle.
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => setScheduleModalOpen(false)}
                    className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSchedule}
                    disabled={schedulingInProgress}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {schedulingInProgress ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CalendarClock className="w-4 h-4" />
                    )}
                    Confirm Schedule
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================
// TEMPLATE CARD
// =====================================================

function TemplateCard({
  template,
  onUse,
  onRun,
  onSchedule,
  serverOnline,
}: {
  template: AffiliatePromptTemplate;
  onUse: () => void;
  onRun: () => void;
  onSchedule: () => void;
  serverOnline: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const category = PROMPT_CATEGORIES.find((c) => c.value === template.category);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${category?.bgColor || 'bg-gray-50 border-gray-200'} border`}>
              {getCategoryIcon(template.category)}
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900 leading-tight">{template.title}</h4>
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">{template.description}</p>
            </div>
          </div>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1.5 mt-3 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${category?.bgColor || 'bg-gray-100'} ${category?.color || 'text-gray-600'}`}>
            {category?.label || template.category}
          </span>
          {template.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-[10px]">
              {tag}
            </span>
          ))}
          {template.schedulable && (
            <span className="px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[10px] flex items-center gap-1">
              <CalendarClock className="w-2.5 h-2.5" />
              Schedulable
            </span>
          )}
        </div>

        {/* Expandable prompt preview */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-600 mt-3 transition-colors"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? 'Hide prompt' : 'Prompt preview'}
        </button>

        {expanded && (
          <div className="mt-2 bg-gray-50 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap max-h-[200px] overflow-y-auto border border-gray-100 leading-relaxed">
            {template.prompt}
          </div>
        )}

        {/* Config info */}
        <div className="flex items-center gap-3 mt-3 text-[11px] text-gray-400">
          {template.startUrl && (
            <span className="flex items-center gap-1">
              <Globe className="w-3 h-3" />
              {new URL(template.startUrl).hostname}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {template.maxTurns} max turns
          </span>
        </div>
      </div>

      {/* Actions footer */}
      <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50 flex items-center gap-2">
        <button
          onClick={onUse}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <FileText className="w-3 h-3" />
          Use prompt
        </button>
        <button
          onClick={onRun}
          disabled={!serverOnline}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          <Play className="w-3 h-3" />
          Run now
        </button>
        {template.schedulable && (
          <button
            onClick={onSchedule}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-xs font-medium hover:bg-amber-600 transition-colors ml-auto"
          >
            <CalendarClock className="w-3 h-3" />
            Schedule
          </button>
        )}
      </div>
    </div>
  );
}

// =====================================================
// SCHEDULED JOB CARD
// =====================================================

function ScheduledJobCard({
  job,
  onToggle,
  onDelete,
  onRunNow,
}: {
  job: ScheduledBrowserJob;
  onToggle: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const category = PROMPT_CATEGORIES.find((c) => c.value === job.category);
  const isOverdue = job.is_active && new Date(job.next_run_at) <= new Date();

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${
      job.is_active ? 'border-gray-200' : 'border-gray-100 opacity-60'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
              job.is_active 
                ? (category?.bgColor || 'bg-gray-50 border-gray-200')
                : 'bg-gray-100 border-gray-200'
            } border`}>
              {getCategoryIcon(job.category as PromptCategory)}
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900">{job.title}</h4>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${category?.bgColor || 'bg-gray-100'} ${category?.color || 'text-gray-600'}`}>
                  {category?.label || job.category}
                </span>
                <span className="text-[10px] text-gray-400 flex items-center gap-1">
                  <CalendarClock className="w-2.5 h-2.5" />
                  {formatFrequency(job.frequency)}
                </span>
                {isOverdue && (
                  <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded-full text-[10px] font-medium">
                    Awaiting execution
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={onRunNow}
              className="p-1.5 hover:bg-blue-50 rounded-lg transition-colors"
              title="Run now"
            >
              <Play className="w-4 h-4 text-blue-500" />
            </button>
            <button
              onClick={onToggle}
              className={`p-1.5 rounded-lg transition-colors ${
                job.is_active ? 'hover:bg-amber-50' : 'hover:bg-green-50'
              }`}
              title={job.is_active ? 'Pause' : 'Reactivate'}
            >
              {job.is_active ? (
                <Pause className="w-4 h-4 text-amber-500" />
              ) : (
                <Power className="w-4 h-4 text-green-500" />
              )}
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="w-4 h-4 text-red-400" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-400">
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {job.total_runs} runs ({job.successful_runs} ok)
          </span>
          {job.last_run_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last: {timeAgo(job.last_run_at)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Timer className="w-3 h-3" />
            Next: {new Date(job.next_run_at).toLocaleDateString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* Last status */}
        {job.last_status && (
          <div className="mt-2">
            {job.last_status === 'error' && job.last_error ? (
              <div className="flex items-center gap-1.5 text-[11px] text-red-500">
                <XCircle className="w-3 h-3" />
                Last error: {job.last_error.slice(0, 100)}
              </div>
            ) : job.last_status === 'completed' || job.last_status === 'running' ? (
              <div className="flex items-center gap-1.5 text-[11px] text-green-500">
                <CheckCircle className="w-3 h-3" />
                Last status: {job.last_status}
              </div>
            ) : null}
          </div>
        )}

        {/* Expand details */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 mt-2 transition-colors"
        >
          {showDetails ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
          {showDetails ? 'Hide details' : 'Show prompt'}
        </button>

        {showDetails && (
          <div className="mt-2 bg-gray-50 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap max-h-[150px] overflow-y-auto border border-gray-100 leading-relaxed">
            {job.prompt}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================
// JOB STATUS PANEL (live progress)
// =====================================================

function JobStatusPanel({ job }: { job: AffiliateBrowserJob }) {
  const statusInfo = formatStatus(job.status);
  const progressPct = job.maxTurns > 0 ? Math.max(2, (job.currentTurn / job.maxTurns) * 100) : 0;

  return (
    <div className="bg-white rounded-lg border border-blue-200 shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.icon}
            {statusInfo.label}
          </span>
          <span className="text-sm text-gray-600 font-medium">
            Turno {job.currentTurn} / {job.maxTurns}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {job.debugUrl && (
            <a
              href={job.debugUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              Watch Live
            </a>
          )}
          {job.createdAt && (
            <span className="text-xs text-gray-400">
              {timeAgo(job.createdAt)}
            </span>
          )}
        </div>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
        <div
          className="bg-blue-500 h-2 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {job.currentUrl && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Globe className="w-3 h-3 shrink-0" />
          <span className="truncate">{job.currentUrl}</span>
          <a
            href={job.currentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-700 shrink-0"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {job.lastActions && job.lastActions.length > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <Zap className="w-3 h-3 text-violet-500 shrink-0" />
          <div className="flex gap-1 flex-wrap">
            {job.lastActions.map((action, i) => (
              <span
                key={i}
                className="px-2 py-0.5 bg-violet-50 text-violet-700 rounded text-xs font-mono"
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================
// CHAT BUBBLE
// =====================================================

function ChatBubble({ message }: { message: AffiliateChatMessage }) {
  const [expanded, setExpanded] = useState(true);
  const isLong = message.content.length > 800;

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex items-start gap-2 max-w-[80%]">
          <div className="bg-blue-600 text-white rounded-2xl rounded-tr-md px-4 py-3 text-sm">
            {message.content}
          </div>
          <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-blue-600" />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="flex justify-center">
        <div className="flex items-center gap-2 bg-gray-100 rounded-full px-4 py-1.5 text-xs text-gray-500">
          <Activity className="w-3 h-3" />
          {message.content}
        </div>
      </div>
    );
  }

  const isThinking = message.id === 'agent-thinking';

  return (
    <div className="flex justify-start">
      <div className="flex items-start gap-2 max-w-[85%]">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isThinking ? 'bg-violet-100' : 'bg-green-100'}`}>
          <Bot className={`w-4 h-4 ${isThinking ? 'text-violet-600' : 'text-green-600'}`} />
        </div>
        <div className={`rounded-2xl rounded-tl-md px-4 py-3 text-sm ${isThinking ? 'bg-violet-50 border border-violet-200' : 'bg-gray-100 border border-gray-200'}`}>
          {isThinking && (
            <div className="flex items-center gap-2 mb-2">
              <Loader2 className="w-3 h-3 animate-spin text-violet-500" />
              <span className="text-xs font-medium text-violet-600">
                Turn {message.turnNumber} — Agent thinking...
              </span>
            </div>
          )}

          {!isThinking && isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 mb-2"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? 'Collapse' : 'Expand result'}
            </button>
          )}

          <div className={`whitespace-pre-wrap break-words leading-relaxed ${!expanded && isLong ? 'max-h-[200px] overflow-hidden relative' : ''}`}>
            {message.content}
            {!expanded && isLong && (
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-gray-100 to-transparent" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================
// EMPTY STATE (with quick template access)
// =====================================================

function EmptyState({ onSelectTemplate }: { onSelectTemplate: (t: AffiliatePromptTemplate) => void }) {
  const quickTemplates = AFFILIATE_PROMPT_TEMPLATES.slice(0, 4);

  return (
    <div className="flex-1 flex items-center justify-center h-full min-h-[400px]">
      <div className="text-center max-w-lg">
        <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <MessageSquare className="w-8 h-8 text-blue-500" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Affiliate Browser Chat</h3>
        <p className="text-sm text-gray-500 mb-6">
          Give a prompt to the browser agent and it will navigate the web for you.
          It can analyze funnels, scrape the Facebook Ad Library, monitor trends and much more.
        </p>

        {/* Quick templates */}
        <div className="space-y-2 text-left">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-1">Quick templates</p>
          {quickTemplates.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelectTemplate(t)}
              className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-200 transition-all w-full text-left group"
            >
              <div className="w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center shrink-0 group-hover:border-blue-200">
                {getCategoryIcon(t.category)}
              </div>
              <div>
                <span className="text-xs font-medium text-gray-700 group-hover:text-blue-700">{t.title}</span>
                <p className="text-[10px] text-gray-400 mt-0.5 line-clamp-1">{t.description}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-2">After getting a result, type:</p>
          <div className="flex gap-2 justify-center">
            <span className="px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded-md text-xs font-medium">Save Quiz</span>
            <span className="px-2.5 py-1 bg-violet-50 text-violet-600 rounded-md text-xs font-medium">Save Funnel</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">to save the result to database with AI classification</p>
        </div>
      </div>
    </div>
  );
}
