'use client';

import { useState, useRef } from 'react';
import Header from '@/components/Header';
import { 
  Search, 
  Loader2, 
  FileText, 
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Sparkles
} from 'lucide-react';

interface AnalysisResponse {
  status: 'completed' | 'failed';
  result: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface PageContent {
  title: string;
  subHeadlines: string[];
  ctaTexts: string[];
  metaDescription: string;
}

interface AnalysisResult {
  headline: string;
  url: string;
  pageContent: PageContent;
  analysis: AnalysisResponse;
}

export default function CopyAnalyzerPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    const url = inputRef.current?.value?.trim() || '';
    
    if (!url) {
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
      const response = await fetch('/api/analyze-copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error during analysis');
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleAnalyze();
    }
  };

  return (
    <div className="min-h-screen">
      <Header 
        title="Copy Analyzer" 
        subtitle="Analyze landing page headlines with AI" 
      />

      <div className="p-6 max-w-4xl mx-auto">
        {/* Input Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-blue-100 p-2 rounded-lg">
              <Sparkles className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Analyze Headline
              </h2>
              <p className="text-sm text-gray-500">
                Enter the URL of a landing page to analyze the headline
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="url"
                placeholder="https://example.com/landing-page"
                onKeyPress={handleKeyPress}
                disabled={isLoading}
                className="w-full px-4 py-3 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
              <ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            </div>
            <button
              onClick={handleAnalyze}
              disabled={isLoading}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" />
                  Analyze
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-red-800">Error</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900">
              Analysis in progress...
            </h3>
            <p className="text-gray-500 mt-2">
              Extracting the headline and analyzing it with AI
            </p>
          </div>
        )}

        {/* Results */}
        {result && !isLoading && (
          <div className="space-y-6">
            {/* Headline Extracted */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-green-100 p-2 rounded-lg">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Headline Extracted
                </h3>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <p className="text-xl font-medium text-gray-900">
                  &quot;{result.headline}&quot;
                </p>
                <a 
                  href={result.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline mt-2 inline-flex items-center gap-1"
                >
                  {result.url}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* Page Content Summary */}
            {result.pageContent && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="bg-blue-100 p-2 rounded-lg">
                    <FileText className="w-5 h-5 text-blue-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    Extracted Content
                  </h3>
                </div>
                <div className="space-y-3">
                  {result.pageContent.metaDescription && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase font-medium mb-1">Meta Description</p>
                      <p className="text-sm text-gray-700">{result.pageContent.metaDescription}</p>
                    </div>
                  )}
                  {result.pageContent.subHeadlines.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase font-medium mb-1">Sub-Headlines</p>
                      <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                        {result.pageContent.subHeadlines.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.pageContent.ctaTexts.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase font-medium mb-1">CTA Buttons</p>
                      <div className="flex flex-wrap gap-2">
                        {result.pageContent.ctaTexts.map((cta, i) => (
                          <span key={i} className="px-3 py-1 bg-blue-50 text-blue-700 text-sm rounded-full border border-blue-200">
                            {cta}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Analysis Result */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-purple-100 p-2 rounded-lg">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    AI Analysis
                  </h3>
                  <div className="flex items-center gap-3 text-sm text-gray-500">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      Completed
                    </span>
                    {result.analysis.model && (
                      <span>Model: {result.analysis.model}</span>
                    )}
                    {result.analysis.usage && (
                      <span>Token: {result.analysis.usage.input_tokens + result.analysis.usage.output_tokens}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Result Content */}
              {result.analysis.result && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap leading-relaxed">
                    {result.analysis.result}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instructions */}
        {!result && !isLoading && !error && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
            <h3 className="font-semibold text-blue-900 mb-3">How it works</h3>
            <ol className="space-y-2 text-blue-800 text-sm">
              <li className="flex items-start gap-2">
                <span className="bg-blue-200 text-blue-900 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
                <span>Enter the full URL of the landing page you want to analyze</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="bg-blue-200 text-blue-900 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
                <span>The system will automatically extract the main headline (H1, title, og:title)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="bg-blue-200 text-blue-900 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
                <span>AI will analyze the headline and provide you with detailed feedback</span>
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
