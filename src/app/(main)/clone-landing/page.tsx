'use client';

import { useState, useRef } from 'react';
import Header from '@/components/Header';
import {
  Copy,
  Loader2,
  ExternalLink,
  Download,
  Maximize2,
  Minimize2,
  Code,
  Eye,
  RefreshCw,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Wand2,
  ChevronDown,
  ChevronUp,
  Paintbrush,
} from 'lucide-react';
import VisualHtmlEditor from '@/components/VisualHtmlEditor';
import { parseJsonResponse } from '@/lib/safe-fetch';

interface ProductInfo {
  name: string;
  description: string;
  benefits: string[];
  target_audience: string;
  price: string;
  cta_text: string;
  cta_url: string;
  brand_name: string;
  social_proof: string;
}

const defaultProduct: ProductInfo = {
  name: '',
  description: '',
  benefits: ['', '', ''],
  target_audience: '',
  price: '',
  cta_text: 'Get Started',
  cta_url: '',
  brand_name: '',
  social_proof: '',
};

export default function CloneLandingPage() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    html: string;
    url: string;
    isSwipedVersion?: boolean;
    swipeInfo?: {
      originalTitle?: string;
      newTitle?: string;
      changesMade?: string[];
      processingTime?: number;
    };
  } | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSwipeForm, setShowSwipeForm] = useState(false);
  const [product, setProduct] = useState<ProductInfo>(defaultProduct);
  const [tone, setTone] = useState<'professional' | 'friendly' | 'urgent' | 'luxury'>('professional');
  const [language, setLanguage] = useState<'it' | 'en'>('it');
  const [showEditor, setShowEditor] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleClone = async () => {
    if (!url.trim()) {
      setError('Enter a valid URL');
      return;
    }

    try {
      new URL(url);
    } catch {
      setError('Invalid URL. Make sure to include http:// or https://');
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/landing/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const parsed = await parseJsonResponse<{
        html?: string;
        data?: unknown;
        url?: string;
        error?: string;
      }>(response);

      if (!parsed.ok) {
        throw new Error(parsed.error || `HTTP ${parsed.status}`);
      }
      const data = parsed.data!;

      if (data.html) {
        setResult({
          html: data.html,
          url: data.url ?? url,
          isSwipedVersion: false,
        });
        setShowSwipeForm(true);
      } else if (data.data) {
        setResult({
          html: `<pre style="padding: 20px; font-family: monospace;">${JSON.stringify(data.data, null, 2)}</pre>`,
          url: data.url ?? url,
        });
      } else {
        throw new Error('No content received');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSwipe = async () => {
    if (!result?.url) return;
    
    // Validate required fields
    if (!product.name.trim()) {
      setError('Enter the product name');
      return;
    }

    setIsSwiping(true);
    setError(null);

    try {
      const response = await fetch('/api/landing/swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: result.url,
          product: {
            ...product,
            benefits: product.benefits.filter(b => b.trim()),
          },
          tone,
          language,
        }),
      });

      // Don't call response.json() directly: when Netlify kills the
      // function (504 Gateway Timeout) the body is an HTML error page
      // and the parser dies with "Unexpected token '<'". parseJsonResponse
      // converts that into a human-readable error.
      const parsed = await parseJsonResponse<{
        html?: string;
        error?: string;
        original_title?: string;
        new_title?: string;
        changes_made?: string[];
        processing_time_seconds?: number;
      }>(response);

      if (!parsed.ok) {
        throw new Error(parsed.error || `HTTP ${parsed.status}`);
      }

      const data = parsed.data!;

      if (data.html) {
        setResult({
          html: data.html,
          url: result.url,
          isSwipedVersion: true,
          swipeInfo: {
            originalTitle: data.original_title,
            newTitle: data.new_title,
            changesMade: data.changes_made,
            processingTime: data.processing_time_seconds,
          },
        });
        setShowSwipeForm(false);
      } else {
        throw new Error(data.error || 'No HTML received');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSwiping(false);
    }
  };

  const handleDownload = () => {
    if (!result?.html) return;
    const filename = result.isSwipedVersion 
      ? `swiped-landing-${product.brand_name || 'custom'}-${Date.now()}.html`
      : `cloned-landing-${Date.now()}.html`;
    
    const blob = new Blob([result.html], { type: 'text/html' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  };

  const handleCopyCode = () => {
    if (!result?.html) return;
    navigator.clipboard.writeText(result.html);
  };

  const updateBenefit = (index: number, value: string) => {
    const newBenefits = [...product.benefits];
    newBenefits[index] = value;
    setProduct({ ...product, benefits: newBenefits });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleClone();
    }
  };

  return (
    <div className={`min-h-screen ${isFullscreen ? 'fixed inset-0 z-50 bg-white' : ''}`}>
      {!isFullscreen && (
        <Header
          title="Clone & Swipe Landing"
          subtitle="Clone landing pages and adapt them to your product"
        />
      )}

      <div className={`${isFullscreen ? 'h-full flex flex-col' : 'p-6'}`}>
        {/* Input Section */}
        <div className={`bg-white rounded-xl shadow-sm border border-gray-200 p-4 ${isFullscreen ? 'mx-4 mt-4' : 'mb-6'}`}>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <input
                type="url"
                placeholder="https://example.com/landing-page"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyPress={handleKeyPress}
                disabled={isLoading || isSwiping}
                className="w-full px-4 py-3 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 disabled:bg-gray-100"
              />
              <ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            </div>
            <button
              onClick={handleClone}
              disabled={isLoading || isSwiping || !url.trim()}
              className="px-6 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Cloning...
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  Clone
                </>
              )}
            </button>
          </div>

          {/* Quick Examples */}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-sm text-gray-500">Examples:</span>
            {['https://stripe.com', 'https://linear.app', 'https://vercel.com'].map((example) => (
              <button
                key={example}
                onClick={() => setUrl(example)}
                className="text-sm text-purple-600 hover:text-purple-800 hover:underline"
              >
                {example.replace('https://', '')}
              </button>
            ))}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className={`bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 ${isFullscreen ? 'mx-4' : 'mb-6'}`}>
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-red-800">Error</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Loading State */}
        {(isLoading || isSwiping) && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center mb-6">
            <Loader2 className="w-12 h-12 text-purple-600 animate-spin mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900">
              {isSwiping ? 'Swipe in progress...' : 'Cloning in progress...'}
            </h3>
            <p className="text-gray-500 mt-2">
              {isSwiping ? 'Adapting the landing to your product' : 'Downloading and processing the page'}
            </p>
          </div>
        )}

        {/* Swipe Form Panel */}
        {result && !isLoading && !isSwiping && (
          <div className={`bg-gradient-to-r from-orange-50 to-yellow-50 border border-orange-200 rounded-xl mb-6 overflow-hidden ${isFullscreen ? 'mx-4' : ''}`}>
            <button
              onClick={() => setShowSwipeForm(!showSwipeForm)}
              className="w-full px-6 py-4 flex items-center justify-between hover:bg-orange-100/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="bg-orange-100 p-2 rounded-lg">
                  <Wand2 className="w-5 h-5 text-orange-600" />
                </div>
                <div className="text-left">
                  <h3 className="font-semibold text-orange-900">
                    {result.isSwipedVersion ? 'Landing Swiped!' : 'Swipe for your Product'}
                  </h3>
                  <p className="text-sm text-orange-700">
                    {result.isSwipedVersion 
                      ? 'Click to edit data and re-swipe'
                      : 'Enter your product data to adapt the landing'}
                  </p>
                </div>
              </div>
              {showSwipeForm ? (
                <ChevronUp className="w-5 h-5 text-orange-600" />
              ) : (
                <ChevronDown className="w-5 h-5 text-orange-600" />
              )}
            </button>

            {showSwipeForm && (
              <div className="px-6 pb-6 border-t border-orange-200">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  {/* Left Column */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Product Name *
                      </label>
                      <input
                        type="text"
                        value={product.name}
                        onChange={(e) => setProduct({ ...product, name: e.target.value })}
                        placeholder="E.g. PayFlow"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Brand Name
                      </label>
                      <input
                        type="text"
                        value={product.brand_name}
                        onChange={(e) => setProduct({ ...product, brand_name: e.target.value })}
                        placeholder="E.g. PayFlow"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Description
                      </label>
                      <textarea
                        value={product.description}
                        onChange={(e) => setProduct({ ...product, description: e.target.value })}
                        placeholder="Describe your product..."
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Audience
                      </label>
                      <input
                        type="text"
                        value={product.target_audience}
                        onChange={(e) => setProduct({ ...product, target_audience: e.target.value })}
                        placeholder="E.g. Small e-commerce businesses"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                  </div>

                  {/* Right Column */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Benefits (one per line)
                      </label>
                      {product.benefits.map((benefit, index) => (
                        <input
                          key={index}
                          type="text"
                          value={benefit}
                          onChange={(e) => updateBenefit(index, e.target.value)}
                          placeholder={`Benefit ${index + 1}`}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 mb-2"
                        />
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Price
                        </label>
                        <input
                          type="text"
                          value={product.price}
                          onChange={(e) => setProduct({ ...product, price: e.target.value })}
                          placeholder="E.g. $29/month"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          CTA Text
                        </label>
                        <input
                          type="text"
                          value={product.cta_text}
                          onChange={(e) => setProduct({ ...product, cta_text: e.target.value })}
                          placeholder="Start Free"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        CTA URL
                      </label>
                      <input
                        type="url"
                        value={product.cta_url}
                        onChange={(e) => setProduct({ ...product, cta_url: e.target.value })}
                        placeholder="https://yoursite.com/signup"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Social Proof
                      </label>
                      <input
                        type="text"
                        value={product.social_proof}
                        onChange={(e) => setProduct({ ...product, social_proof: e.target.value })}
                        placeholder="E.g. Used by 5,000+ businesses"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Tone
                        </label>
                        <select
                          value={tone}
                          onChange={(e) => setTone(e.target.value as typeof tone)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        >
                          <option value="professional">Professional</option>
                          <option value="friendly">Friendly</option>
                          <option value="urgent">Urgent</option>
                          <option value="luxury">Luxury</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Language
                        </label>
                        <select
                          value={language}
                          onChange={(e) => setLanguage(e.target.value as typeof language)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                        >
                          <option value="it">Italian</option>
                          <option value="en">English</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleSwipe}
                  disabled={isSwiping || !product.name.trim()}
                  className="mt-6 w-full px-6 py-3 bg-gradient-to-r from-orange-500 to-yellow-500 text-white rounded-lg font-medium hover:from-orange-600 hover:to-yellow-600 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                >
                  {isSwiping ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Swiping...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-5 h-5" />
                      Swipa Landing
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Swipe Info Banner */}
        {result?.isSwipedVersion && result.swipeInfo && (
          <div className={`bg-green-50 border border-green-200 rounded-xl p-4 mb-6 ${isFullscreen ? 'mx-4' : ''}`}>
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-medium text-green-900">Landing Swiped Successfully!</h3>
                {result.swipeInfo.processingTime && (
                  <p className="text-sm text-green-700 mt-1">
                    Processing time: {result.swipeInfo.processingTime.toFixed(2)}s
                  </p>
                )}
                {result.swipeInfo.changesMade && result.swipeInfo.changesMade.length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-green-800">Changes made:</p>
                    <ul className="text-sm text-green-700 mt-1 space-y-1">
                      {result.swipeInfo.changesMade.slice(0, 5).map((change, i) => (
                        <li key={i}>• {change}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Result Viewer */}
        {result && !isLoading && !isSwiping && (
          <div className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${isFullscreen ? 'flex-1 mx-4 mb-4 flex flex-col' : ''}`}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-3">
                <CheckCircle className={`w-5 h-5 ${result.isSwipedVersion ? 'text-orange-600' : 'text-green-600'}`} />
                <div>
                  <span className="font-medium text-gray-900">
                    {result.isSwipedVersion ? 'Swiped Landing' : 'Cloned Page'}
                  </span>
                  {result.isSwipedVersion && product.brand_name && (
                    <span className="ml-2 px-2 py-0.5 bg-orange-100 text-orange-800 text-xs rounded-full">
                      {product.brand_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* View Mode Toggle */}
                <div className="flex bg-gray-200 rounded-lg p-1">
                  <button
                    onClick={() => setViewMode('preview')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1 ${
                      viewMode === 'preview'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Eye className="w-4 h-4" />
                    Preview
                  </button>
                  <button
                    onClick={() => setViewMode('code')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1 ${
                      viewMode === 'code'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Code className="w-4 h-4" />
                    HTML
                  </button>
                </div>

                {/* Actions */}
                <button
                  onClick={() => setShowEditor(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 transition-colors shadow-sm"
                  title="Edit Visually"
                >
                  <Paintbrush className="w-4 h-4" />
                  Edit
                </button>
                <button
                  onClick={handleCopyCode}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Copy HTML"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  onClick={handleDownload}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Download HTML"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <Minimize2 className="w-4 h-4" />
                  ) : (
                    <Maximize2 className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={handleClone}
                  className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors"
                  title="Reload original"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className={`${isFullscreen ? 'flex-1' : 'h-[600px]'}`}>
              {viewMode === 'preview' ? (
                <iframe
                  ref={iframeRef}
                  srcDoc={result.html}
                  className="w-full h-full border-0"
                  title="Landing Page Preview"
                  sandbox="allow-scripts allow-same-origin"
                />
              ) : (
                <div className="h-full overflow-auto bg-gray-900 p-4">
                  <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                    {result.html}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instructions */}
        {!result && !isLoading && !error && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-purple-100 p-2 rounded-lg">
                  <Copy className="w-5 h-5 text-purple-600" />
                </div>
                <h3 className="font-semibold text-purple-900">1. Clone</h3>
              </div>
              <p className="text-purple-800 text-sm">
                Enter the URL of a successful landing page and click &quot;Clone&quot; to download it.
              </p>
            </div>

            <div className="bg-orange-50 border border-orange-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-orange-100 p-2 rounded-lg">
                  <Wand2 className="w-5 h-5 text-orange-600" />
                </div>
                <h3 className="font-semibold text-orange-900">2. Swipe</h3>
              </div>
              <p className="text-orange-800 text-sm">
                Enter your product data and AI will adapt the landing for you automatically.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-amber-100 p-2 rounded-lg">
                  <Paintbrush className="w-5 h-5 text-amber-600" />
                </div>
                <h3 className="font-semibold text-amber-900">3. Edit</h3>
              </div>
              <p className="text-amber-800 text-sm">
                Use the visual editor to customize text, images, colors and layout.
              </p>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-green-100 p-2 rounded-lg">
                  <Download className="w-5 h-5 text-green-600" />
                </div>
                <h3 className="font-semibold text-green-900">4. Use</h3>
              </div>
              <p className="text-green-800 text-sm">
                Download the final HTML and use it for your business.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Visual HTML Editor */}
      {showEditor && result?.html && (
        <VisualHtmlEditor
          initialHtml={result.html}
          pageTitle={result.isSwipedVersion ? `Swiped Landing - ${product.brand_name || 'Custom'}` : 'Cloned Landing'}
          onSave={(html) => {
            setResult({ ...result, html });
          }}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}
