'use client';

import { useState, useCallback } from 'react';
import Header from '@/components/Header';
import {
  Rocket,
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Eye,
  Code,
  FileCode,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldCheck,
  Zap,
  Settings,
  Copy,
  Image as ImageIcon,
} from 'lucide-react';

type Platform = 'checkout_champ' | 'funnelish';
type DeployTab = 'upload' | 'result';

interface DeployStepLog {
  step: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  timestamp: string;
  screenshotBase64?: string;
}

interface DeployResultData {
  success: boolean;
  platform: Platform;
  status: string;
  funnelUrl?: string;
  previewUrl?: string;
  screenshotBase64?: string;
  steps: DeployStepLog[];
  error?: string;
  durationMs: number;
}

const PLATFORM_CONFIG: Record<Platform, { label: string; color: string; bgColor: string; description: string }> = {
  checkout_champ: {
    label: 'Checkout Champ',
    color: 'text-orange-600',
    bgColor: 'bg-orange-50 border-orange-200',
    description: 'Import HTML page + CRM tracking (Click, Lead, Order, Upsale)',
  },
  funnelish: {
    label: 'Funnelish',
    color: 'text-purple-600',
    bgColor: 'bg-purple-50 border-purple-200',
    description: 'Import HTML page via Custom HTML element in the funnel builder',
  },
};

const STATUS_STYLES: Record<string, string> = {
  ok: 'text-green-600 bg-green-50',
  warn: 'text-yellow-600 bg-yellow-50',
  error: 'text-red-600 bg-red-50',
};

export default function DeployFunnelPage() {
  const [platform, setPlatform] = useState<Platform>('checkout_champ');
  const [tab, setTab] = useState<DeployTab>('upload');

  // Form fields
  const [html, setHtml] = useState('');
  const [funnelName, setFunnelName] = useState('');
  const [pageName, setPageName] = useState('');
  const [pageType, setPageType] = useState('landing');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [injectTracking, setInjectTracking] = useState(true);
  const [headless, setHeadless] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // State
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<DeployResultData | null>(null);
  const [previewHtml, setPreviewHtml] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setHtml(content);
      if (!funnelName) {
        const match = content.match(/<title[^>]*>(.*?)<\/title>/i);
        if (match?.[1]) setFunnelName(match[1].trim());
      }
    };
    reader.readAsText(file);
  }, [funnelName]);

  const handleDeploy = useCallback(async () => {
    if (!html || !funnelName || !email || !password) return;

    setDeploying(true);
    setResult(null);

    try {
      const endpoint = platform === 'checkout_champ'
        ? '/api/deploy/checkout-champ'
        : '/api/deploy/funnelish';

      const body: Record<string, unknown> = {
        html,
        funnelName,
        pageName: pageName || funnelName,
        pageType,
        email,
        password,
        headless,
      };

      if (platform === 'checkout_champ') {
        body.subdomain = subdomain;
        body.campaignId = campaignId ? Number(campaignId) : undefined;
        body.injectTracking = injectTracking;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data: DeployResultData = await res.json();
      setResult(data);
      setTab('result');
    } catch (err) {
      setResult({
        success: false,
        platform,
        status: 'failed',
        steps: [],
        error: err instanceof Error ? err.message : 'Network error',
        durationMs: 0,
      });
      setTab('result');
    } finally {
      setDeploying(false);
    }
  }, [html, funnelName, email, password, platform, pageName, pageType, subdomain, campaignId, injectTracking, headless]);

  const isFormValid = html && funnelName && email && password;

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      <Header
        title="Deploy Funnel"
        subtitle="Import HTML pages to Checkout Champ and Funnelish"
      />

      <div className="flex-1 p-6 space-y-6 max-w-5xl mx-auto w-full">
        {/* Platform Selector */}
        <div className="grid grid-cols-2 gap-4">
          {(Object.entries(PLATFORM_CONFIG) as [Platform, typeof PLATFORM_CONFIG[Platform]][]).map(
            ([key, cfg]) => (
              <button
                key={key}
                onClick={() => setPlatform(key)}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  platform === key
                    ? `${cfg.bgColor} border-current ring-2 ring-offset-2 ${key === 'checkout_champ' ? 'ring-orange-400' : 'ring-purple-400'}`
                    : 'bg-white border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className={`font-semibold text-lg ${platform === key ? cfg.color : 'text-gray-700'}`}>
                  {cfg.label}
                </div>
                <p className="text-sm text-gray-500 mt-1">{cfg.description}</p>
                {platform === key && (
                  <div className="absolute top-3 right-3">
                    <CheckCircle2 className={`w-5 h-5 ${cfg.color}`} />
                  </div>
                )}
              </button>
            ),
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setTab('upload')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
              tab === 'upload' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Upload className="w-4 h-4" />
            Upload & Config
          </button>
          <button
            onClick={() => setTab('result')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
              tab === 'result' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            } ${!result ? 'opacity-50 cursor-not-allowed' : ''}`}
            disabled={!result}
          >
            <Rocket className="w-4 h-4" />
            Result
            {result && (
              <span className={`w-2 h-2 rounded-full ${result.success ? 'bg-green-500' : 'bg-red-500'}`} />
            )}
          </button>
        </div>

        {/* Upload Tab */}
        {tab === 'upload' && (
          <div className="space-y-6">
            {/* HTML Input */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Code className="w-5 h-5 text-blue-500" />
                Funnel HTML
              </h3>

              <div className="flex gap-3">
                <label className="flex-1 flex items-center justify-center gap-2 p-4 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <FileCode className="w-5 h-5 text-gray-400" />
                  <span className="text-sm text-gray-600">
                    {html ? `${(html.length / 1024).toFixed(1)} KB loaded` : 'Upload HTML file'}
                  </span>
                  <input
                    type="file"
                    accept=".html,.htm"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                {html && (
                  <button
                    onClick={() => setPreviewHtml(!previewHtml)}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
                  >
                    <Eye className="w-4 h-4" />
                    {previewHtml ? 'Hide' : 'Preview'}
                  </button>
                )}
              </div>

              <div className="relative">
                <textarea
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                  placeholder="Paste HTML code here or upload a file..."
                  className="w-full h-40 p-4 border border-gray-300 rounded-lg font-mono text-xs resize-y focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {html && (
                  <span className="absolute bottom-3 right-3 text-xs text-gray-400">
                    {html.length.toLocaleString()} chars
                  </span>
                )}
              </div>

              {previewHtml && html && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-100 px-3 py-1.5 text-xs text-gray-500 flex items-center gap-2">
                    <Eye className="w-3 h-3" />
                    Preview HTML
                  </div>
                  <iframe
                    srcDoc={html}
                    className="w-full h-96 bg-white"
                    sandbox="allow-same-origin"
                    title="HTML Preview"
                  />
                </div>
              )}
            </div>

            {/* Funnel Config */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Settings className="w-5 h-5 text-gray-500" />
                Funnel Configuration
              </h3>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Funnel Name *
                  </label>
                  <input
                    type="text"
                    value={funnelName}
                    onChange={(e) => setFunnelName(e.target.value)}
                    placeholder="e.g. Quiz Weight Loss IT"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Page Name
                  </label>
                  <input
                    type="text"
                    value={pageName}
                    onChange={(e) => setPageName(e.target.value)}
                    placeholder="e.g. Landing Page v2"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Page Type
                  </label>
                  <select
                    value={pageType}
                    onChange={(e) => setPageType(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="landing">Landing Page</option>
                    <option value="presell">Pre-Sell / Advertorial</option>
                    <option value="checkout">Checkout</option>
                    <option value="upsell">Upsell / OTO</option>
                    <option value="downsell">Downsell</option>
                    <option value="thankyou">Thank You</option>
                    <option value="quiz">Quiz Funnel</option>
                    <option value="lander">Lander</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Platform Credentials */}
            <div className={`rounded-xl border p-6 space-y-4 ${PLATFORM_CONFIG[platform].bgColor}`}>
              <h3 className={`font-semibold flex items-center gap-2 ${PLATFORM_CONFIG[platform].color}`}>
                <ShieldCheck className="w-5 h-5" />
                {PLATFORM_CONFIG[platform].label} Credentials
              </h3>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password *</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  />
                </div>
              </div>

              {platform === 'checkout_champ' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Subdomain CRM
                    </label>
                    <div className="flex items-center gap-0">
                      <input
                        type="text"
                        value={subdomain}
                        onChange={(e) => setSubdomain(e.target.value)}
                        placeholder="mystore"
                        className="w-full px-3 py-2 border border-gray-300 rounded-l-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                      />
                      <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 rounded-r-lg text-sm text-gray-500 whitespace-nowrap">
                        .checkoutchamp.com
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Campaign ID
                    </label>
                    <input
                      type="number"
                      value={campaignId}
                      onChange={(e) => setCampaignId(e.target.value)}
                      placeholder="e.g. 12345"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                    />
                  </div>
                </div>
              )}

              {platform === 'checkout_champ' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={injectTracking}
                    onChange={(e) => setInjectTracking(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                  />
                  <span className="text-sm text-gray-700">
                    Inject tracking script (automatic Import Click)
                  </span>
                </label>
              )}
            </div>

            {/* Advanced Settings */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700"
            >
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              Advanced settings
            </button>

            {showAdvanced && (
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={headless}
                    onChange={(e) => setHeadless(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    Headless mode (invisible browser, faster)
                  </span>
                </label>
              </div>
            )}

            {/* Deploy Button */}
            <button
              onClick={handleDeploy}
              disabled={!isFormValid || deploying}
              className={`w-full py-3.5 rounded-xl font-semibold text-white flex items-center justify-center gap-2 transition-all ${
                !isFormValid || deploying
                  ? 'bg-gray-300 cursor-not-allowed'
                  : platform === 'checkout_champ'
                    ? 'bg-orange-600 hover:bg-orange-700 shadow-lg shadow-orange-200'
                    : 'bg-purple-600 hover:bg-purple-700 shadow-lg shadow-purple-200'
              }`}
            >
              {deploying ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Deploying to {PLATFORM_CONFIG[platform].label}...
                </>
              ) : (
                <>
                  <Rocket className="w-5 h-5" />
                  Deploy to {PLATFORM_CONFIG[platform].label}
                </>
              )}
            </button>
          </div>
        )}

        {/* Result Tab */}
        {tab === 'result' && result && (
          <div className="space-y-6">
            {/* Status Banner */}
            <div
              className={`p-6 rounded-xl border-2 ${
                result.success
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}
            >
              <div className="flex items-center gap-3">
                {result.success ? (
                  <CheckCircle2 className="w-8 h-8 text-green-600" />
                ) : (
                  <AlertCircle className="w-8 h-8 text-red-600" />
                )}
                <div>
                  <h3 className={`font-bold text-lg ${result.success ? 'text-green-800' : 'text-red-800'}`}>
                    {result.success ? 'Deploy completed!' : 'Deploy failed'}
                  </h3>
                  <p className="text-sm text-gray-600 mt-0.5">
                    {PLATFORM_CONFIG[result.platform].label} — {(result.durationMs / 1000).toFixed(1)}s
                  </p>
                </div>
              </div>

              {result.error && (
                <div className="mt-3 p-3 bg-red-100 rounded-lg text-sm text-red-700 font-mono">
                  {result.error}
                </div>
              )}

              {result.funnelUrl && (
                <div className="mt-4 flex items-center gap-3">
                  <a
                    href={result.funnelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open Funnel
                  </a>
                  <button
                    onClick={() => navigator.clipboard.writeText(result.funnelUrl!)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
                  >
                    <Copy className="w-4 h-4" />
                    Copy URL
                  </button>
                </div>
              )}
            </div>

            {/* Screenshot */}
            {result.screenshotBase64 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 text-sm font-medium text-gray-700">
                  <ImageIcon className="w-4 h-4" />
                  Final screenshot
                </div>
                <img
                  src={`data:image/jpeg;base64,${result.screenshotBase64}`}
                  alt="Deploy screenshot"
                  className="w-full"
                />
              </div>
            )}

            {/* Step Log */}
            <div className="bg-white rounded-xl border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 text-sm font-medium text-gray-700">
                <Zap className="w-4 h-4" />
                Automation log ({result.steps.length} steps)
              </div>
              <div className="divide-y divide-gray-100">
                {result.steps.map((step, i) => (
                  <div key={i} className="px-4 py-3">
                    <button
                      onClick={() => setExpandedStep(expandedStep === i ? null : i)}
                      className="w-full flex items-center gap-3 text-left"
                    >
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[step.status] || ''}`}
                      >
                        {step.status.toUpperCase()}
                      </span>
                      <span className="text-sm font-medium text-gray-800 flex-1">
                        {step.step.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(step.timestamp).toLocaleTimeString()}
                      </span>
                      {step.screenshotBase64 && (
                        expandedStep === i ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />
                      )}
                    </button>
                    <p className="text-xs text-gray-500 mt-1 ml-16">{step.message}</p>
                    {expandedStep === i && step.screenshotBase64 && (
                      <div className="mt-3 ml-16">
                        <img
                          src={`data:image/jpeg;base64,${step.screenshotBase64}`}
                          alt={`Step ${step.step}`}
                          className="rounded-lg border border-gray-200 max-h-60 object-contain"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
