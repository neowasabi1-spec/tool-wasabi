'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { 
  Flame, 
  Play, 
  Loader2, 
  CheckCircle, 
  AlertCircle, 
  Copy, 
  Download,
  Eye,
  Code,
  FileText,
  Map,
  Globe,
  Settings,
  ChevronDown,
  ChevronUp,
  Key,
  Clock,
  ExternalLink,
  Wand2,
  Package,
  RefreshCw
} from 'lucide-react';

type FirecrawlAction = 'scrape' | 'crawl' | 'map';
type DashboardTab = 'firecrawl' | 'swipe';

interface FirecrawlOptions {
  formats: string[];
  onlyMainContent: boolean;
  includeTags: string[];
  excludeTags: string[];
  waitFor: number;
  limit: number;
  maxDepth: number;
  allowBackwardLinks: boolean;
  allowExternalLinks: boolean;
  search: string;
  ignoreSitemap: boolean;
  includeSubdomains: boolean;
}

interface ApiResponse {
  success: boolean;
  action?: string;
  url?: string;
  duration?: number;
  data?: unknown;
  error?: string;
}

interface SwipeProduct {
  name: string;
  description: string;
  benefits: string[];
  price: string;
  cta_text: string;
  cta_url: string;
  brand_name: string;
}

interface SwipeResponse {
  success: boolean;
  original_url?: string;
  original_title?: string;
  new_title?: string;
  html?: string;
  changes_made?: string[];
  original_length?: number;
  new_length?: number;
  processing_time_seconds?: number;
  method_used?: string;
  error?: string | null;
  warnings?: string[];
}

const defaultSwipeProduct: SwipeProduct = {
  name: '',
  description: '',
  benefits: [''],
  price: '',
  cta_text: 'BUY NOW',
  cta_url: '',
  brand_name: '',
};

const defaultOptions: FirecrawlOptions = {
  formats: ['markdown', 'html'],
  onlyMainContent: true,
  includeTags: [],
  excludeTags: [],
  waitFor: 0,
  limit: 10,
  maxDepth: 2,
  allowBackwardLinks: false,
  allowExternalLinks: false,
  search: '',
  ignoreSitemap: false,
  includeSubdomains: false,
};

export default function FirecrawlPage() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('swipe');
  
  // Firecrawl API state
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [action, setAction] = useState<FirecrawlAction>('scrape');
  const [options, setOptions] = useState<FirecrawlOptions>(defaultOptions);
  const [showOptions, setShowOptions] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');
  const [showApiKey, setShowApiKey] = useState(false);
  
  // Swipe API state
  const [swipeUrl, setSwipeUrl] = useState('');
  const [swipeProduct, setSwipeProduct] = useState<SwipeProduct>(defaultSwipeProduct);
  const [swipeLanguage, setSwipeLanguage] = useState('it');
  const [isSwipeLoading, setIsSwipeLoading] = useState(false);
  const [swipeResponse, setSwipeResponse] = useState<SwipeResponse | null>(null);
  const [showSwipePreview, setShowSwipePreview] = useState(false);
  const [benefitInput, setBenefitInput] = useState('');

  const handleSubmit = async () => {
    if (!url.trim() || !apiKey.trim()) return;

    setIsLoading(true);
    setResponse(null);

    try {
      const res = await fetch('/api/firecrawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          action,
          apiKey: apiKey.trim(),
          options,
        }),
      });

      const data = await res.json();
      setResponse(data);
    } catch (error) {
      setResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSwipeSubmit = async () => {
    if (!swipeUrl.trim() || !swipeProduct.name.trim()) return;

    setIsSwipeLoading(true);
    setSwipeResponse(null);

    try {
      const res = await fetch('https://claude-code-agents.fly.dev/api/firecrawl/swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: swipeUrl.trim(),
          product: {
            name: swipeProduct.name,
            description: swipeProduct.description,
            benefits: swipeProduct.benefits.filter(b => b.trim() !== ''),
            price: swipeProduct.price,
            cta_text: swipeProduct.cta_text,
            cta_url: swipeProduct.cta_url,
            brand_name: swipeProduct.brand_name,
          },
          language: swipeLanguage,
        }),
      });

      const data = await res.json();
      setSwipeResponse(data);
    } catch (error) {
      setSwipeResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      });
    } finally {
      setIsSwipeLoading(false);
    }
  };

  const addBenefit = () => {
    if (benefitInput.trim()) {
      setSwipeProduct({
        ...swipeProduct,
        benefits: [...swipeProduct.benefits.filter(b => b.trim() !== ''), benefitInput.trim()],
      });
      setBenefitInput('');
    }
  };

  const removeBenefit = (index: number) => {
    setSwipeProduct({
      ...swipeProduct,
      benefits: swipeProduct.benefits.filter((_, i) => i !== index),
    });
  };

  const downloadSwipedHtml = () => {
    if (!swipeResponse?.html) return;
    const blob = new Blob([swipeResponse.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swiped-${swipeProduct.brand_name || 'page'}-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const downloadJson = () => {
    if (!response?.data) return;
    const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `firecrawl-${action}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getActionIcon = (a: FirecrawlAction) => {
    switch (a) {
      case 'scrape': return <FileText className="w-4 h-4" />;
      case 'crawl': return <Globe className="w-4 h-4" />;
      case 'map': return <Map className="w-4 h-4" />;
    }
  };

  const getActionDescription = (a: FirecrawlAction) => {
    switch (a) {
      case 'scrape': return 'Extracts content from a single page';
      case 'crawl': return 'Crawls a site following links';
      case 'map': return 'Maps all URLs of a site';
    }
  };

  const renderFormattedData = (data: unknown): React.ReactNode => {
    if (!data) return null;

    // For scrape action
    if (typeof data === 'object' && data !== null && 'data' in data) {
      const scrapeData = (data as { data: { markdown?: string; html?: string; metadata?: Record<string, unknown> } }).data;
      
      return (
        <div className="space-y-4">
          {scrapeData.metadata && (
            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Metadata
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(scrapeData.metadata).map(([key, value]) => (
                  <div key={key} className="flex">
                    <span className="font-medium text-gray-600 min-w-[120px]">{key}:</span>
                    <span className="text-gray-800 truncate">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {scrapeData.markdown && (
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Markdown Content
                </h4>
                <button
                  onClick={() => copyToClipboard(scrapeData.markdown || '')}
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
              </div>
              <div className="bg-white rounded border p-4 max-h-[400px] overflow-auto">
                <pre className="text-sm text-gray-800 whitespace-pre-wrap">{scrapeData.markdown}</pre>
              </div>
            </div>
          )}

          {scrapeData.html && (
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Code className="w-4 h-4" />
                  HTML Content
                </h4>
                <button
                  onClick={() => copyToClipboard(scrapeData.html || '')}
                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
              </div>
              <div className="bg-white rounded border p-4 max-h-[300px] overflow-auto">
                <pre className="text-xs text-gray-700 whitespace-pre-wrap">{scrapeData.html}</pre>
              </div>
            </div>
          )}
        </div>
      );
    }

    // For map action - list of URLs
    if (typeof data === 'object' && data !== null && 'links' in data) {
      const links = (data as { links: string[] }).links;
      return (
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-gray-900 flex items-center gap-2">
              <Map className="w-4 h-4" />
              URLs Found ({links.length})
            </h4>
            <button
              onClick={() => copyToClipboard(links.join('\n'))}
              className="text-sm text-blue-600 hover:underline flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              Copy all
            </button>
          </div>
          <div className="bg-white rounded border max-h-[400px] overflow-auto divide-y">
            {links.map((link: string, i: number) => (
              <div key={i} className="px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50">
                <span className="text-gray-800 truncate flex-1">{link}</span>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-700 ml-2"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // For crawl action
    if (typeof data === 'object' && data !== null && 'status' in data) {
      const crawlData = data as { status: string; total?: number; completed?: number; creditsUsed?: number; expiresAt?: string; data?: Array<{ markdown?: string; metadata?: { sourceURL?: string } }> };
      return (
        <div className="space-y-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="font-semibold text-gray-900 mb-2">Crawl Status</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Status:</span>
                <span className="ml-2 font-medium">{crawlData.status}</span>
              </div>
              {crawlData.total && (
                <div>
                  <span className="text-gray-500">Total:</span>
                  <span className="ml-2 font-medium">{crawlData.total}</span>
                </div>
              )}
              {crawlData.completed && (
                <div>
                  <span className="text-gray-500">Completed:</span>
                  <span className="ml-2 font-medium">{crawlData.completed}</span>
                </div>
              )}
              {crawlData.creditsUsed && (
                <div>
                  <span className="text-gray-500">Credits used:</span>
                  <span className="ml-2 font-medium">{crawlData.creditsUsed}</span>
                </div>
              )}
            </div>
          </div>
          
          {crawlData.data && crawlData.data.length > 0 && (
            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="font-semibold text-gray-900 mb-3">Crawled Pages ({crawlData.data.length})</h4>
              <div className="space-y-3">
                {crawlData.data.map((page, i) => (
                  <div key={i} className="bg-white rounded border p-3">
                    <div className="text-sm text-blue-600 mb-2 truncate">
                      {page.metadata?.sourceURL || `Page ${i + 1}`}
                    </div>
                    {page.markdown && (
                      <div className="text-xs text-gray-600 max-h-[100px] overflow-hidden">
                        {page.markdown.slice(0, 500)}...
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Fallback to raw JSON
    return (
      <pre className="text-sm text-gray-800 whitespace-pre-wrap overflow-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Firecrawl API Dashboard"
        subtitle="Scraping, Crawling and Swipe with Firecrawl"
      />

      <div className="p-6 max-w-6xl mx-auto">
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('swipe')}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              activeTab === 'swipe'
                ? 'bg-purple-600 text-white'
                : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <Wand2 className="w-5 h-5" />
            Firecrawl Swipe
          </button>
          <button
            onClick={() => setActiveTab('firecrawl')}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              activeTab === 'firecrawl'
                ? 'bg-orange-600 text-white'
                : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <Flame className="w-5 h-5" />
            Firecrawl API
          </button>
        </div>

        {/* ==================== SWIPE TAB ==================== */}
        {activeTab === 'swipe' && (
          <>
            {/* Swipe Info Box */}
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <Wand2 className="w-6 h-6 text-purple-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-purple-900">Firecrawl Swipe API</h3>
                  <p className="text-purple-800 text-sm mt-1">
                    Enter the URL of a landing page and your product data. The API will use Firecrawl 
                    to extract the content and then &quot;swipe&quot; it by replacing the information with your product&apos;s.
                  </p>
                </div>
              </div>
            </div>

            {/* Swipe Form */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left Column - URL and Product Info */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Source URL to Swipe *
                    </label>
                    <input
                      type="url"
                      value={swipeUrl}
                      onChange={(e) => setSwipeUrl(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none"
                      placeholder="https://landing-page-to-copy.com"
                    />
                  </div>

                  <div className="border-t pt-4">
                    <h4 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                      <Package className="w-4 h-4 text-purple-600" />
                      Product Data
                    </h4>
                    
                    <div className="space-y-3">
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Product Name *</label>
                        <input
                          type="text"
                          value={swipeProduct.name}
                          onChange={(e) => setSwipeProduct({ ...swipeProduct, name: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                          placeholder="Your Product"
                        />
                      </div>

                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Brand Name</label>
                        <input
                          type="text"
                          value={swipeProduct.brand_name}
                          onChange={(e) => setSwipeProduct({ ...swipeProduct, brand_name: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                          placeholder="YourBrand"
                        />
                      </div>

                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Description</label>
                        <textarea
                          value={swipeProduct.description}
                          onChange={(e) => setSwipeProduct({ ...swipeProduct, description: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                          rows={2}
                          placeholder="Product description..."
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">Price</label>
                          <input
                            type="text"
                            value={swipeProduct.price}
                            onChange={(e) => setSwipeProduct({ ...swipeProduct, price: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                            placeholder="€99"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">Language</label>
                          <select
                            value={swipeLanguage}
                            onChange={(e) => setSwipeLanguage(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                          >
                            <option value="it">Italian</option>
                            <option value="en">English</option>
                            <option value="es">Español</option>
                            <option value="fr">Français</option>
                            <option value="de">Deutsch</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column - CTA and Benefits */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">CTA Text</label>
                    <input
                      type="text"
                      value={swipeProduct.cta_text}
                      onChange={(e) => setSwipeProduct({ ...swipeProduct, cta_text: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                      placeholder="BUY NOW"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">URL CTA</label>
                    <input
                      type="url"
                      value={swipeProduct.cta_url}
                      onChange={(e) => setSwipeProduct({ ...swipeProduct, cta_url: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                      placeholder="https://yoursite.com/buy"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">Benefits</label>
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        value={benefitInput}
                        onChange={(e) => setBenefitInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addBenefit())}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                        placeholder="Add a benefit..."
                      />
                      <button
                        type="button"
                        onClick={addBenefit}
                        className="px-3 py-2 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200"
                      >
                        +
                      </button>
                    </div>
                    <div className="space-y-1.5 max-h-[200px] overflow-auto">
                      {swipeProduct.benefits.filter(b => b.trim() !== '').map((benefit, index) => (
                        <div key={index} className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg">
                          <span className="text-sm text-gray-700 flex-1">{benefit}</span>
                          <button
                            onClick={() => removeBenefit(index)}
                            className="text-red-500 hover:text-red-700"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {swipeProduct.benefits.filter(b => b.trim() !== '').length === 0 && (
                        <p className="text-sm text-gray-400 italic">No benefits added</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <div className="mt-6 pt-4 border-t">
                <button
                  onClick={handleSwipeSubmit}
                  disabled={isSwipeLoading || !swipeUrl.trim() || !swipeProduct.name.trim()}
                  className="w-full flex items-center justify-center gap-2 bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {isSwipeLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Swiping...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-5 h-5" />
                      Launch Swipe with Firecrawl
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Swipe Response */}
            {swipeResponse && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                {/* Response Header */}
                <div className={`px-6 py-4 flex items-center justify-between ${
                  swipeResponse.success ? 'bg-green-50 border-b border-green-200' : 'bg-red-50 border-b border-red-200'
                }`}>
                  <div className="flex items-center gap-3">
                    {swipeResponse.success ? (
                      <CheckCircle className="w-6 h-6 text-green-600" />
                    ) : (
                      <AlertCircle className="w-6 h-6 text-red-600" />
                    )}
                    <div>
                      <h3 className={`font-semibold ${swipeResponse.success ? 'text-green-900' : 'text-red-900'}`}>
                        {swipeResponse.success ? 'Swipe Completed!' : 'Swipe Error'}
                      </h3>
                      {swipeResponse.processing_time_seconds && (
                        <p className="text-sm text-gray-600 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {swipeResponse.processing_time_seconds.toFixed(2)}s
                          {swipeResponse.method_used && (
                            <span className="ml-2 text-xs bg-gray-200 px-2 py-0.5 rounded">
                              {swipeResponse.method_used}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>

                  {swipeResponse.success && swipeResponse.html && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowSwipePreview(!showSwipePreview)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${
                          showSwipePreview 
                            ? 'bg-purple-600 text-white' 
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        <Eye className="w-4 h-4" />
                        {showSwipePreview ? 'Hide' : 'Preview'}
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(swipeResponse.html || '')}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
                      >
                        <Copy className="w-4 h-4" />
                        Copy HTML
                      </button>
                      <button
                        onClick={downloadSwipedHtml}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </button>
                    </div>
                  )}
                </div>

                {/* Response Body */}
                <div className="p-6">
                  {swipeResponse.error ? (
                    <div className="text-red-700">
                      <p className="font-medium">Error:</p>
                      <p className="mt-1">{swipeResponse.error}</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Stats */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-gray-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">Original Title</p>
                          <p className="font-medium text-sm truncate">{swipeResponse.original_title || '-'}</p>
                        </div>
                        <div className="bg-purple-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">New Title</p>
                          <p className="font-medium text-sm text-purple-700 truncate">{swipeResponse.new_title || '-'}</p>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">Original Length</p>
                          <p className="font-medium text-sm">{swipeResponse.original_length?.toLocaleString()} chars</p>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3">
                          <p className="text-xs text-gray-500">New Length</p>
                          <p className="font-medium text-sm">{swipeResponse.new_length?.toLocaleString()} chars</p>
                        </div>
                      </div>

                      {/* Changes Made */}
                      {swipeResponse.changes_made && swipeResponse.changes_made.length > 0 && (
                        <div className="bg-green-50 rounded-lg p-4">
                          <h4 className="font-medium text-green-900 mb-2 flex items-center gap-2">
                            <RefreshCw className="w-4 h-4" />
                            Changes Made ({swipeResponse.changes_made.length})
                          </h4>
                          <ul className="space-y-1 text-sm text-green-800">
                            {swipeResponse.changes_made.map((change, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                {change}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Warnings */}
                      {swipeResponse.warnings && swipeResponse.warnings.length > 0 && (
                        <div className="bg-yellow-50 rounded-lg p-4">
                          <h4 className="font-medium text-yellow-900 mb-2 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            Warnings
                          </h4>
                          <ul className="space-y-1 text-sm text-yellow-800">
                            {swipeResponse.warnings.map((warning, i) => (
                              <li key={i}>• {warning}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* HTML Preview */}
                      {showSwipePreview && swipeResponse.html && (
                        <div className="border border-gray-300 rounded-lg overflow-hidden">
                          <div className="bg-gray-100 px-4 py-2 border-b flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-700">Swiped HTML Preview</span>
                            <a
                              href={swipeResponse.original_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                            >
                              Original <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                          <iframe
                            srcDoc={swipeResponse.html}
                            className="w-full h-[500px] bg-white"
                            sandbox="allow-same-origin"
                            title="Swiped Page Preview"
                          />
                        </div>
                      )}

                      {/* Raw HTML Code */}
                      {!showSwipePreview && swipeResponse.html && (
                        <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[400px]">
                          <pre className="text-green-400 text-xs font-mono whitespace-pre-wrap">
                            {swipeResponse.html.slice(0, 5000)}
                            {swipeResponse.html.length > 5000 && '\n\n... (truncated, download for full content)'}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* ==================== FIRECRAWL API TAB ==================== */}
        {activeTab === 'firecrawl' && (
          <>
            {/* Info Box */}
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <Flame className="w-6 h-6 text-orange-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-orange-900">Firecrawl API</h3>
                  <p className="text-orange-800 text-sm mt-1">
                    Use this dashboard to test Firecrawl APIs. Enter your API key and a URL to perform 
                    scraping, crawling or mapping of websites.
                  </p>
                </div>
              </div>
            </div>

            {/* API Key Input */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
            <Key className="w-4 h-4" />
            Firecrawl API Key
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none font-mono text-sm"
                placeholder="fc-xxxxxxxxxxxxxxxxxxxxxxxx"
              />
            </div>
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
            >
              <Eye className="w-5 h-5" />
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            The key is not saved and is only used for this session.
          </p>
        </div>

        {/* Main Form */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Action Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Action</label>
              <div className="space-y-2">
                {(['scrape', 'crawl', 'map'] as FirecrawlAction[]).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAction(a)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                      action === a
                        ? 'border-orange-500 bg-orange-50 text-orange-700'
                        : 'border-gray-200 hover:border-gray-300 text-gray-700'
                    }`}
                  >
                    {getActionIcon(a)}
                    <div className="text-left">
                      <div className="font-medium capitalize">{a}</div>
                      <div className="text-xs text-gray-500">{getActionDescription(a)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* URL Input */}
            <div className="lg:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">URL to {action === 'scrape' ? 'scrape' : action === 'crawl' ? 'crawl' : 'map'}</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none"
                placeholder="https://example.com"
              />

              {/* Options Toggle */}
              <button
                onClick={() => setShowOptions(!showOptions)}
                className="mt-3 flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800"
              >
                <Settings className="w-4 h-4" />
                Advanced options
                {showOptions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {/* Advanced Options */}
              {showOptions && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg space-y-4">
                  {action === 'scrape' && (
                    <>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={options.onlyMainContent}
                            onChange={(e) => setOptions({ ...options, onlyMainContent: e.target.checked })}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">Main content only</span>
                        </label>
                      </div>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Output formats</label>
                        <div className="flex gap-2">
                          {['markdown', 'html', 'links', 'screenshot'].map((format) => (
                            <label key={format} className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={options.formats.includes(format)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setOptions({ ...options, formats: [...options.formats, format] });
                                  } else {
                                    setOptions({ ...options, formats: options.formats.filter(f => f !== format) });
                                  }
                                }}
                                className="rounded border-gray-300"
                              />
                              <span className="text-sm capitalize">{format}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Wait (ms)</label>
                        <input
                          type="number"
                          value={options.waitFor}
                          onChange={(e) => setOptions({ ...options, waitFor: parseInt(e.target.value) || 0 })}
                          className="w-32 px-3 py-1.5 border border-gray-300 rounded text-sm"
                          placeholder="0"
                        />
                      </div>
                    </>
                  )}

                  {action === 'crawl' && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">Page limit</label>
                          <input
                            type="number"
                            value={options.limit}
                            onChange={(e) => setOptions({ ...options, limit: parseInt(e.target.value) || 10 })}
                            className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">Max Depth</label>
                          <input
                            type="number"
                            value={options.maxDepth}
                            onChange={(e) => setOptions({ ...options, maxDepth: parseInt(e.target.value) || 2 })}
                            className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={options.allowExternalLinks}
                            onChange={(e) => setOptions({ ...options, allowExternalLinks: e.target.checked })}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">External links</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={options.allowBackwardLinks}
                            onChange={(e) => setOptions({ ...options, allowBackwardLinks: e.target.checked })}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">Backward links</span>
                        </label>
                      </div>
                    </>
                  )}

                  {action === 'map' && (
                    <>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Search (URL filter)</label>
                        <input
                          type="text"
                          value={options.search}
                          onChange={(e) => setOptions({ ...options, search: e.target.value })}
                          className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                          placeholder="e.g. blog, product"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">URL limit</label>
                        <input
                          type="number"
                          value={options.limit}
                          onChange={(e) => setOptions({ ...options, limit: parseInt(e.target.value) || 100 })}
                          className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm"
                        />
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={options.includeSubdomains}
                            onChange={(e) => setOptions({ ...options, includeSubdomains: e.target.checked })}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">Include subdomains</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={options.ignoreSitemap}
                            onChange={(e) => setOptions({ ...options, ignoreSitemap: e.target.checked })}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm">Ignore sitemap</span>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Submit Button */}
              <button
                onClick={handleSubmit}
                disabled={isLoading || !url.trim() || !apiKey.trim()}
                className="mt-4 w-full flex items-center justify-center gap-2 bg-orange-600 text-white px-6 py-3 rounded-lg hover:bg-orange-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    Run {action.charAt(0).toUpperCase() + action.slice(1)}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Response Section */}
        {response && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            {/* Response Header */}
            <div className={`px-6 py-4 flex items-center justify-between ${
              response.success ? 'bg-green-50 border-b border-green-200' : 'bg-red-50 border-b border-red-200'
            }`}>
              <div className="flex items-center gap-3">
                {response.success ? (
                  <CheckCircle className="w-6 h-6 text-green-600" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-red-600" />
                )}
                <div>
                  <h3 className={`font-semibold ${response.success ? 'text-green-900' : 'text-red-900'}`}>
                    {response.success ? 'Request completed' : 'Error'}
                  </h3>
                  {response.duration && (
                    <p className="text-sm text-gray-600 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {response.duration.toFixed(2)}s
                    </p>
                  )}
                </div>
              </div>

              {response.success && response.data ? (
                <div className="flex items-center gap-2">
                  <div className="flex border border-gray-300 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setViewMode('formatted')}
                      className={`px-3 py-1.5 text-sm ${
                        viewMode === 'formatted' 
                          ? 'bg-gray-200 text-gray-800' 
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Formatted
                    </button>
                    <button
                      onClick={() => setViewMode('raw')}
                      className={`px-3 py-1.5 text-sm ${
                        viewMode === 'raw' 
                          ? 'bg-gray-200 text-gray-800' 
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      Raw JSON
                    </button>
                  </div>
                  <button
                    onClick={downloadJson}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </button>
                </div>
              ) : null}
            </div>

            {/* Response Body */}
            <div className="p-6">
              {response.error ? (
                <div className="text-red-700">
                  <p className="font-medium">Error:</p>
                  <p className="mt-1">{response.error}</p>
                </div>
              ) : response.data ? (
                viewMode === 'formatted' ? (
                  renderFormattedData(response.data)
                ) : (
                  <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[600px]">
                    <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">
                      {JSON.stringify(response.data, null, 2)}
                    </pre>
                  </div>
                )
              ) : (
                <p className="text-gray-500">No data in response</p>
              )}
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
