'use client';

import { useState, useEffect } from 'react';
import { HelpCircle, Eye, Tag, FileCode, Layers, Plus, Monitor, Smartphone, ChevronRight, ChevronLeft, X, Download, ExternalLink, Sparkles, BarChart } from 'lucide-react';
import Image from 'next/image';

interface QuizArchiveItem {
  id: string;
  name: string;
  url: string;
  category: string;
  tags: string[];
  total_steps: number;
  screenshots_count: number;
  html_files_count: number;
  assets_count: number;
  overview: string;
  target_audience?: string;
  quiz_structure?: string;
  copy_patterns?: string;
  technical_notes?: string;
  key_insights?: string;
  scraped_at: string;
  created_at: string;
  local_path: string;
}

interface QuizArchiveViewProps {
  searchTerm: string;
  onAddNew: () => void;
  onPreview: (quiz: { url: string; name: string }) => void;
}

export default function QuizArchiveView({ searchTerm, onAddNew, onPreview }: QuizArchiveViewProps) {
  const [quizzes, setQuizzes] = useState<QuizArchiveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuiz, setSelectedQuiz] = useState<QuizArchiveItem | null>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop');

  useEffect(() => {
    fetchQuizzes();
  }, []);

  const fetchQuizzes = async () => {
    try {
      const response = await fetch('/api/quiz-archive');
      const data = await response.json();
      setQuizzes(data);
    } catch (error) {
      console.error('Error fetching quizzes:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter quizzes based on search
  const filteredQuizzes = searchTerm.trim()
    ? quizzes.filter(q => 
        q.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        q.tags.some(tag => tag.toLowerCase().includes(searchTerm.toLowerCase())) ||
        q.url.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : quizzes;

  // Get screenshot path for a quiz step
  const getScreenshotPath = (quiz: QuizArchiveItem, step: number, isMobile: boolean = false) => {
    const baseName = quiz.name.toLowerCase().replace(/\s+/g, '-');
    const device = isMobile ? 'mobile' : 'desktop';
    // This is a placeholder - in real implementation, you'd fetch from your storage
    return `/api/quiz-screenshots/${quiz.id}/step-${step}-${device}.png`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          <p className="text-sm text-gray-500">Loading quiz archive...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Quiz Archive</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Scraped quiz funnels with complete analysis and assets. {quizzes.length} quizzes archived.
          </p>
        </div>
        <button
          onClick={onAddNew}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Scrape New Quiz
        </button>
      </div>

      {filteredQuizzes.length === 0 ? (
        <div className="text-center py-16">
          <HelpCircle className="w-16 h-16 text-gray-200 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-500 mb-2">
            {quizzes.length === 0 ? 'No quiz archives yet' : 'No results found'}
          </h3>
          <p className="text-sm text-gray-400">
            {quizzes.length === 0 
              ? 'Start by scraping competitor quiz funnels'
              : 'Try a different search term'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredQuizzes.map((quiz) => (
            <div 
              key={quiz.id} 
              className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all group relative cursor-pointer"
              onClick={() => {
                setSelectedQuiz(quiz);
                setCurrentStep(1);
              }}
            >
              <div className="relative">
                <div className="h-[200px] bg-gradient-to-br from-orange-100 to-amber-100 relative overflow-hidden">
                  {/* Preview screenshots grid */}
                  <div className="absolute inset-0 grid grid-cols-2 gap-1 p-2 opacity-30">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="bg-white/50 rounded-lg backdrop-blur-sm flex items-center justify-center">
                        <FileCode className="w-8 h-8 text-orange-400" />
                      </div>
                    ))}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <HelpCircle className="w-16 h-16 text-orange-500" />
                  </div>
                </div>
                <div className="absolute top-3 left-3 flex items-center gap-2">
                  <span className="px-3 py-1 bg-orange-500/90 text-white rounded-lg text-xs font-semibold shadow-sm">
                    {quiz.name}
                  </span>
                </div>
                <div className="absolute top-3 right-3 flex flex-col gap-1 items-end">
                  <span className="px-2 py-0.5 bg-white/90 backdrop-blur-sm rounded text-[10px] font-semibold text-gray-800 shadow-sm">
                    {quiz.total_steps || quiz.screenshots_count / 2} steps
                  </span>
                  <span className="px-2 py-0.5 bg-black/80 text-white rounded text-[10px] font-medium">
                    {quiz.screenshots_count} screens
                  </span>
                </div>
              </div>

              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-bold text-gray-900 text-base">{quiz.name}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{quiz.url || 'URL not available'}</p>
                  </div>
                </div>
                
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{quiz.overview}</p>
                
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-3 text-gray-500">
                    <span className="flex items-center gap-1">
                      <Monitor className="w-3.5 h-3.5" />
                      Desktop
                    </span>
                    <span className="flex items-center gap-1">
                      <Smartphone className="w-3.5 h-3.5" />
                      Mobile
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (quiz.url) onPreview({ url: quiz.url, name: quiz.name });
                    }}
                    className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Live
                  </button>
                </div>

                <div className="flex flex-wrap gap-1 mt-3">
                  {quiz.tags.filter(tag => tag !== quiz.name.toLowerCase()).slice(0, 3).map((tag, i) => (
                    <span key={i} className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Enhanced Detail Modal */}
      {selectedQuiz && (
        <div 
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedQuiz(null)}
        >
          <div 
            className="bg-white rounded-xl max-w-7xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className="text-2xl font-bold">{selectedQuiz.name}</h2>
                <div className="flex gap-2">
                  <span className="px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-sm font-medium">
                    {selectedQuiz.total_steps || selectedQuiz.screenshots_count / 2} steps
                  </span>
                  <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
                    {selectedQuiz.screenshots_count} screenshots
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedQuiz(null)}
                className="text-gray-400 hover:text-gray-600 p-1"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-hidden flex">
              {/* Left Panel - Screenshots */}
              <div className="flex-1 bg-gray-50 p-6 overflow-y-auto">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">Quiz Flow</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setViewMode('desktop')}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        viewMode === 'desktop' 
                          ? 'bg-white text-gray-900 shadow-sm' 
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Monitor className="w-4 h-4 inline mr-1" />
                      Desktop
                    </button>
                    <button
                      onClick={() => setViewMode('mobile')}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        viewMode === 'mobile' 
                          ? 'bg-white text-gray-900 shadow-sm' 
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Smartphone className="w-4 h-4 inline mr-1" />
                      Mobile
                    </button>
                  </div>
                </div>

                {/* Step Navigator */}
                <div className="mb-6 flex items-center justify-between bg-white rounded-lg p-3 shadow-sm">
                  <button
                    onClick={() => setCurrentStep(Math.max(1, currentStep - 1))}
                    disabled={currentStep === 1}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-500">Step</span>
                    <span className="font-bold text-lg">{currentStep}</span>
                    <span className="text-sm text-gray-500">of {selectedQuiz.total_steps || selectedQuiz.screenshots_count / 2}</span>
                  </div>
                  
                  <button
                    onClick={() => setCurrentStep(Math.min(selectedQuiz.total_steps || selectedQuiz.screenshots_count / 2, currentStep + 1))}
                    disabled={currentStep === (selectedQuiz.total_steps || selectedQuiz.screenshots_count / 2)}
                    className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                {/* Screenshot Display */}
                <div className={`bg-white rounded-lg shadow-sm overflow-hidden ${
                  viewMode === 'mobile' ? 'max-w-sm mx-auto' : ''
                }`}>
                  <div className="relative aspect-[9/16] bg-gray-100 flex items-center justify-center">
                    {/* Placeholder for screenshot */}
                    <div className="text-center">
                      <FileCode className="w-16 h-16 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">
                        Step {currentStep} - {viewMode === 'mobile' ? 'Mobile' : 'Desktop'} View
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Screenshot from {selectedQuiz.local_path}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step Thumbnails */}
                <div className="mt-6 grid grid-cols-6 gap-2">
                  {Array.from({ length: selectedQuiz.total_steps || selectedQuiz.screenshots_count / 2 }).map((_, i) => (
                    <button
                      key={i}
                      onClick={() => setCurrentStep(i + 1)}
                      className={`aspect-[3/4] rounded border-2 transition-all ${
                        currentStep === i + 1 
                          ? 'border-orange-500 shadow-md' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="w-full h-full bg-gray-100 flex items-center justify-center text-xs font-medium text-gray-500">
                        {i + 1}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Right Panel - Analysis */}
              <div className="w-[400px] border-l border-gray-200 p-6 overflow-y-auto">
                <div className="space-y-6">
                  {/* Overview */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                      <HelpCircle className="w-4 h-4 text-gray-500" />
                      Overview
                    </h3>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.overview}</p>
                  </div>

                  {/* Target Audience */}
                  {selectedQuiz.target_audience && (
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Tag className="w-4 h-4 text-gray-500" />
                        Target Audience
                      </h3>
                      <p className="text-sm text-gray-600">{selectedQuiz.target_audience}</p>
                    </div>
                  )}

                  {/* Quiz Structure */}
                  {selectedQuiz.quiz_structure && (
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Layers className="w-4 h-4 text-gray-500" />
                        Quiz Structure
                      </h3>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.quiz_structure}</p>
                    </div>
                  )}

                  {/* Copy Patterns */}
                  {selectedQuiz.copy_patterns && (
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <FileCode className="w-4 h-4 text-gray-500" />
                        Copy Patterns
                      </h3>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.copy_patterns}</p>
                    </div>
                  )}

                  {/* Key Insights */}
                  {selectedQuiz.key_insights && (
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-gray-500" />
                        Key Insights
                      </h3>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.key_insights}</p>
                    </div>
                  )}

                  {/* Technical Notes */}
                  {selectedQuiz.technical_notes && (
                    <div>
                      <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <BarChart className="w-4 h-4 text-gray-500" />
                        Technical Notes
                      </h3>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.technical_notes}</p>
                    </div>
                  )}

                  {/* Assets Info */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Assets</h3>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xl font-bold text-gray-900">{selectedQuiz.screenshots_count}</div>
                        <div className="text-xs text-gray-500">Screenshots</div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xl font-bold text-gray-900">{selectedQuiz.html_files_count}</div>
                        <div className="text-xs text-gray-500">HTML Files</div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-xl font-bold text-gray-900">{selectedQuiz.assets_count}</div>
                        <div className="text-xs text-gray-500">Assets</div>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="space-y-2">
                    <button className="w-full px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors flex items-center justify-center gap-2">
                      <Download className="w-4 h-4" />
                      Download All Assets
                    </button>
                    {selectedQuiz.url && (
                      <button
                        onClick={() => {
                          onPreview({ url: selectedQuiz.url, name: selectedQuiz.name });
                          setSelectedQuiz(null);
                        }}
                        className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
                      >
                        <ExternalLink className="w-4 h-4" />
                        View Original Quiz
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}