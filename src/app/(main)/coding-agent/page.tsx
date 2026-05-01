'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  MessageSquarePlus,
  GitBranch,
  ExternalLink,
  Copy,
  Bot,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface LaunchResponse {
  id: string;
  name?: string;
  status?: string;
  source?: { repository?: string; ref?: string };
  target?: {
    branchName?: string;
    url?: string;
    prUrl?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  createdAt?: string;
}

export default function CodingAgentPage() {
  const [promptText, setPromptText] = useState('');
  const [repository, setRepository] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [ref, setRef] = useState('main');
  const [model, setModel] = useState('');
  const [autoCreatePr, setAutoCreatePr] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [openAsCursorGithubApp, setOpenAsCursorGithubApp] = useState(false);
  const [skipReviewerRequest, setSkipReviewerRequest] = useState(false);
  const [autoBranch, setAutoBranch] = useState(true);
  const [showTargetOptions, setShowTargetOptions] = useState(false);

  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ success: boolean; data?: LaunchResponse; error?: string } | null>(null);

  const [followupAgentId, setFollowupAgentId] = useState('');
  const [followupText, setFollowupText] = useState('');
  const [followupLoading, setFollowupLoading] = useState(false);
  const [followupResult, setFollowupResult] = useState<{ success: boolean; data?: { id: string }; error?: string } | null>(null);

  const launchAgent = async () => {
    if (!promptText.trim()) return;
    if (!repository.trim() && !prUrl.trim()) return;

    setLaunchLoading(true);
    setLaunchResult(null);
    try {
      const source: { repository?: string; ref?: string; prUrl?: string } = {};
      if (prUrl.trim()) {
        source.prUrl = prUrl.trim();
      } else {
        source.repository = repository.trim();
        if (ref.trim()) source.ref = ref.trim();
      }

      const target: Record<string, unknown> = {};
      if (autoCreatePr) target.autoCreatePr = true;
      if (openAsCursorGithubApp) target.openAsCursorGithubApp = true;
      if (skipReviewerRequest) target.skipReviewerRequest = true;
      if (branchName.trim()) target.branchName = branchName.trim();
      if (prUrl.trim()) target.autoBranch = autoBranch;

      const response = await fetch('/api/cursor-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: { text: promptText.trim() },
          ...(model.trim() && { model: model.trim() }),
          source,
          ...(Object.keys(target).length > 0 && { target }),
        }),
      });
      const json = await response.json();

      if (!response.ok) {
        setLaunchResult({ success: false, error: json.error || 'Launch failed' });
        return;
      }
      setLaunchResult({ success: true, data: json.data });
      setFollowupAgentId(json.data?.id || '');
    } catch (error) {
      setLaunchResult({
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      });
    } finally {
      setLaunchLoading(false);
    }
  };

  const addFollowup = async () => {
    if (!followupAgentId.trim() || !followupText.trim()) return;

    setFollowupLoading(true);
    setFollowupResult(null);
    try {
      const response = await fetch(`/api/cursor-agents/${encodeURIComponent(followupAgentId.trim())}/followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: { text: followupText.trim() } }),
      });
      const json = await response.json();

      if (!response.ok) {
        setFollowupResult({ success: false, error: json.error || 'Follow-up failed' });
        return;
      }
      setFollowupResult({ success: true, data: json.data });
      setFollowupText('');
    } catch (error) {
      setFollowupResult({
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      });
    } finally {
      setFollowupLoading(false);
    }
  };

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Coding Agent AI"
        subtitle="Launch Cursor cloud agents and add follow-ups via API"
      />

      <div className="p-6 max-w-4xl">
        {/* Launch Agent */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-500" />
            Launch Agent
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Task prompt (required)</label>
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder="e.g. Add a README.md file with installation instructions"
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Repository URL</label>
                <input
                  type="url"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="https://github.com/your-org/your-repo"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  disabled={!!prUrl.trim()}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Or Pull Request URL</label>
                <input
                  type="url"
                  value={prUrl}
                  onChange={(e) => setPrUrl(e.target.value)}
                  placeholder="https://github.com/org/repo/pull/123"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
              </div>
            </div>

            {!prUrl.trim() && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ref (branch, tag, or commit)</label>
                <input
                  type="text"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="main"
                  className="w-full max-w-xs px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model (optional)</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. claude-4-sonnet"
                className="w-full max-w-xs px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>

            {/* Target options */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowTargetOptions(!showTargetOptions)}
                className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 text-gray-700 hover:bg-gray-100"
              >
                <span className="font-medium text-sm flex items-center gap-2">
                  <GitBranch className="w-4 h-4" />
                  Target options
                </span>
                {showTargetOptions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showTargetOptions && (
                <div className="p-4 space-y-3 border-t border-gray-200">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoCreatePr}
                      onChange={(e) => setAutoCreatePr(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300"
                    />
                    <span className="text-sm text-gray-700">Auto-create PR when done</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={openAsCursorGithubApp}
                      onChange={(e) => setOpenAsCursorGithubApp(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300"
                    />
                    <span className="text-sm text-gray-700">Open PR as Cursor GitHub App</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipReviewerRequest}
                      onChange={(e) => setSkipReviewerRequest(e.target.checked)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300"
                    />
                    <span className="text-sm text-gray-700">Skip adding user as reviewer</span>
                  </label>
                  {prUrl.trim() && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoBranch}
                        onChange={(e) => setAutoBranch(e.target.checked)}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300"
                      />
                      <span className="text-sm text-gray-700">Create new branch (otherwise push to PR head)</span>
                    </label>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Branch name (optional)</label>
                    <input
                      type="text"
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="feature/add-readme"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={launchAgent}
              disabled={launchLoading || !promptText.trim() || (!repository.trim() && !prUrl.trim())}
              className="flex items-center gap-2 px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {launchLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Play className="w-5 h-5" />
              )}
              Launch Agent
            </button>
          </div>

          {launchResult && (
            <div className={`mt-4 p-4 rounded-lg border ${launchResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
              {launchResult.success && launchResult.data ? (
                <>
                  <div className="flex items-center gap-2 text-green-800 font-medium mb-2">
                    <CheckCircle className="w-5 h-5" />
                    Agent launched
                  </div>
                  <div className="space-y-1 text-sm text-gray-700">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono bg-gray-200 px-2 py-0.5 rounded">{launchResult.data.id}</span>
                      <button
                        type="button"
                        onClick={() => copyId(launchResult.data!.id)}
                        className="text-gray-500 hover:text-gray-700 flex items-center gap-1"
                      >
                        <Copy className="w-4 h-4" />
                        Copy
                      </button>
                    </div>
                    {launchResult.data.name && <p><strong>Name:</strong> {launchResult.data.name}</p>}
                    {launchResult.data.status && <p><strong>Status:</strong> {launchResult.data.status}</p>}
                    {launchResult.data.createdAt && <p><strong>Created:</strong> {new Date(launchResult.data.createdAt).toLocaleString()}</p>}
                    {launchResult.data.target?.url && (
                      <a
                        href={launchResult.data.target.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        Open in Cursor <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                    {launchResult.data.target?.prUrl && (
                      <a
                        href={launchResult.data.target.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline ml-4"
                      >
                        View PR <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-red-800">
                  <XCircle className="w-5 h-5 shrink-0" />
                  <span>{launchResult.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Add Follow-up */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <MessageSquarePlus className="w-5 h-5 text-green-500" />
            Add Follow-up
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Agent ID</label>
              <input
                type="text"
                value={followupAgentId}
                onChange={(e) => setFollowupAgentId(e.target.value)}
                placeholder="bc_abc123"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Follow-up instruction</label>
              <textarea
                value={followupText}
                onChange={(e) => setFollowupText(e.target.value)}
                placeholder="e.g. Also add a section about troubleshooting"
                rows={3}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              />
            </div>
            <button
              onClick={addFollowup}
              disabled={followupLoading || !followupAgentId.trim() || !followupText.trim()}
              className="flex items-center gap-2 px-5 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {followupLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <MessageSquarePlus className="w-5 h-5" />
              )}
              Send Follow-up
            </button>
          </div>

          {followupResult && (
            <div className={`mt-4 p-4 rounded-lg border ${followupResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
              {followupResult.success ? (
                <div className="flex items-center gap-2 text-green-800">
                  <CheckCircle className="w-5 h-5" />
                  Follow-up sent to agent {followupResult.data?.id || followupAgentId}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-800">
                  <XCircle className="w-5 h-5 shrink-0" />
                  <span>{followupResult.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <p className="mt-6 text-sm text-gray-500">
          Configure <code className="bg-gray-200 px-1 rounded">CURSOR_API_KEY</code> in your environment for the API to work.
        </p>
      </div>
    </div>
  );
}
