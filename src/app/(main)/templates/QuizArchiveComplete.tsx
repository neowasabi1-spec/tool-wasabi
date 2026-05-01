'use client';

import { useState, useEffect } from 'react';
import { HelpCircle, Eye, Tag, FileCode, Layers, Plus, ChevronRight, ChevronLeft, X, Monitor, Smartphone, Copy, ExternalLink, Download, Sparkles, Code } from 'lucide-react';
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
  screenshot_urls?: string[];
  screenshot_data?: Record<number, { desktop?: string; mobile?: string }>;
}

export default function QuizArchiveView({ searchTerm, onAddNew, onPreview }: any) {
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

  const filteredQuizzes = searchTerm.trim()
    ? quizzes.filter(q => 
        q.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        q.tags.some(tag => tag.toLowerCase().includes(searchTerm.toLowerCase()))
      )
    : quizzes;

  const downloadHTML = async (quiz: QuizArchiveItem) => {
    // Create a download link for HTML files
    const quizName = quiz.name.toLowerCase();
    alert(`HTML files are located at:\n${quiz.local_path}\\html\\\n\nTotal files: ${quiz.html_files_count}`);
    
    // In a real implementation, you'd create a zip file server-side
    // For now, we'll create a simple instructions file
    const instructions = `${quiz.name} Quiz HTML Files
============================

Total HTML files: ${quiz.html_files_count}
Local path: ${quiz.local_path}\\html\\

To access the files:
1. Navigate to the folder above
2. All HTML files are named step-0.html, step-1.html, etc.
3. Each file contains the complete HTML for that quiz step

File contents include:
- Complete HTML structure
- All form elements and inputs
- Inline styles and classes
- Embedded JavaScript
- All copy and text content

${quiz.copy_patterns ? '\nCopy Patterns Found:\n' + quiz.copy_patterns : ''}
`;
    
    const blob = new Blob([instructions], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quizName}-html-info.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-orange-400 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          <p className="text-sm text-gray-500">Loading quiz archive...</p>
        </div>
      </div>
    );
  }

  const getQuizColor = (name: string) => {
    const colors = {
      'Bioma': 'from-green-400 to-emerald-500',
      'Terrashell': 'from-blue-400 to-indigo-500',
      'Mounjaro': 'from-purple-400 to-pink-500',
      'Magnetmind': 'from-indigo-400 to-purple-500',
      'Bliz-german': 'from-gray-600 to-gray-800'
    };
    return colors[name] || 'from-orange-400 to-red-500';
  };

  const getScreenshotUrl = (quiz: QuizArchiveItem, step: number, device: 'desktop' | 'mobile') => {
    // Try to get from screenshot_data first
    if (quiz.screenshot_data && quiz.screenshot_data[step - 1]) {
      return quiz.screenshot_data[step - 1][device];
    }
    
    // Fallback to screenshot_urls array
    if (quiz.screenshot_urls && quiz.screenshot_urls.length > 0) {
      const index = (step - 1) * 2 + (device === 'mobile' ? 1 : 0);
      return quiz.screenshot_urls[index];
    }
    
    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Quiz Archive</h2>
          <p className="text-sm text-gray-500 mt-1">
            Complete analysis of {quizzes.length} competitor quiz funnels with screenshots
          </p>
        </div>
        <button
          onClick={onAddNew}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors shadow-md"
        >
          <Plus className="w-4 h-4" />
          Scrape New Quiz
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredQuizzes.map((quiz) => {
          const firstScreenshot = getScreenshotUrl(quiz, 1, 'desktop');
          
          return (
            <div 
              key={quiz.id} 
              className="bg-white rounded-xl shadow-md hover:shadow-xl transition-all cursor-pointer overflow-hidden group"
              onClick={() => {
                setSelectedQuiz(quiz);
                setCurrentStep(1);
              }}
            >
              {/* Preview */}
              <div className={`h-48 bg-gradient-to-br ${getQuizColor(quiz.name)} relative overflow-hidden`}>
                {firstScreenshot ? (
                  <img 
                    src={firstScreenshot} 
                    alt={`${quiz.name} preview`}
                    className="w-full h-full object-cover object-top"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <HelpCircle className="w-16 h-16 text-white/50" />
                  </div>
                )}
                
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                
                <div className="absolute bottom-3 left-3 text-white">
                  <h3 className="font-bold text-lg">{quiz.name}</h3>
                  <p className="text-sm opacity-90">{quiz.total_steps || Math.floor(quiz.screenshots_count / 2)} steps</p>
                </div>
                
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <Eye className="w-8 h-8 text-white" />
                </div>
              </div>

              {/* Card Content */}
              <div className="p-5">
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{quiz.overview}</p>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Monitor className="w-3.5 h-3.5" />
                      {Math.floor(quiz.screenshots_count / 2)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Smartphone className="w-3.5 h-3.5" />
                      {Math.floor(quiz.screenshots_count / 2)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Code className="w-3.5 h-3.5" />
                      {quiz.html_files_count}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadHTML(quiz);
                    }}
                    className="text-orange-600 hover:text-orange-800"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Enhanced Modal */}
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
            <div className="border-b border-gray-200 px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold">{selectedQuiz.name}</h2>
                  <p className="text-sm text-gray-500">{selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2)} steps • {selectedQuiz.screenshots_count} screenshots • {selectedQuiz.html_files_count} HTML files</p>
                </div>
                <button
                  onClick={() => setSelectedQuiz(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex overflow-hidden">
              {/* Left Panel - Screenshots */}
              <div className="flex-1 bg-gray-50 overflow-y-auto">
                <div className="p-6">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="font-semibold">Quiz Flow</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setViewMode('desktop')}
                        className={`px-3 py-1.5 rounded text-sm ${viewMode === 'desktop' ? 'bg-white shadow' : ''}`}
                      >
                        <Monitor className="w-4 h-4 inline mr-1" />
                        Desktop
                      </button>
                      <button
                        onClick={() => setViewMode('mobile')}
                        className={`px-3 py-1.5 rounded text-sm ${viewMode === 'mobile' ? 'bg-white shadow' : ''}`}
                      >
                        <Smartphone className="w-4 h-4 inline mr-1" />
                        Mobile
                      </button>
                    </div>
                  </div>

                  {/* Step Navigator */}
                  <div className="mb-6 bg-white rounded-lg p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => setCurrentStep(Math.max(1, currentStep - 1))}
                        disabled={currentStep === 1}
                        className="p-2 hover:bg-gray-100 rounded disabled:opacity-50"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <div className="text-center">
                        <div className="text-2xl font-bold">Step {currentStep}</div>
                        <div className="text-sm text-gray-500">of {selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2)}</div>
                      </div>
                      <button
                        onClick={() => setCurrentStep(Math.min(selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2), currentStep + 1))}
                        disabled={currentStep === (selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2))}
                        className="p-2 hover:bg-gray-100 rounded disabled:opacity-50"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                  </div>

                  {/* Screenshot Display */}
                  <div className={`mx-auto ${viewMode === 'mobile' ? 'max-w-sm' : 'max-w-3xl'}`}>
                    <div className={`bg-white rounded-lg shadow-lg overflow-hidden ${viewMode === 'mobile' ? 'aspect-[9/16]' : 'aspect-[16/10]'}`}>
                      {(() => {
                        const screenshotUrl = getScreenshotUrl(selectedQuiz, currentStep, viewMode);
                        return screenshotUrl ? (
                          <img 
                            src={screenshotUrl}
                            alt={`Step ${currentStep} - ${viewMode}`}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gray-100">
                            <div className="text-center">
                              <FileCode className="w-16 h-16 text-gray-300 mx-auto mb-2" />
                              <p className="text-sm text-gray-500">Screenshot not available</p>
                              <p className="text-xs text-gray-400 mt-1">{selectedQuiz.local_path}</p>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Step Thumbnails */}
                  <div className="mt-6 grid grid-cols-6 gap-2">
                    {Array.from({ length: selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2) }).map((_, i) => {
                      const thumbUrl = getScreenshotUrl(selectedQuiz, i + 1, 'desktop');
                      return (
                        <button
                          key={i}
                          onClick={() => setCurrentStep(i + 1)}
                          className={`aspect-[3/4] rounded border-2 overflow-hidden transition-all ${
                            currentStep === i + 1 ? 'border-orange-500 shadow-md' : 'border-gray-200'
                          }`}
                        >
                          {thumbUrl ? (
                            <img src={thumbUrl} alt={`Step ${i + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-gray-100 flex items-center justify-center text-xs font-medium text-gray-500">
                              {i + 1}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Right Panel */}
              <div className="w-[450px] border-l border-gray-200 overflow-y-auto">
                <div className="p-6 space-y-6">
                  {/* Overview */}
                  <div>
                    <h3 className="font-semibold mb-2">Overview</h3>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.overview}</p>
                  </div>

                  {selectedQuiz.target_audience && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Tag className="w-4 h-4" />
                        Target Audience
                      </h3>
                      <p className="text-sm text-gray-600">{selectedQuiz.target_audience}</p>
                    </div>
                  )}

                  {selectedQuiz.quiz_structure && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Layers className="w-4 h-4" />
                        Quiz Structure
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 p-3 rounded">{selectedQuiz.quiz_structure}</pre>
                    </div>
                  )}

                  {selectedQuiz.copy_patterns && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Copy className="w-4 h-4" />
                        Copy Patterns
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-blue-50 p-3 rounded">{selectedQuiz.copy_patterns}</pre>
                    </div>
                  )}

                  {selectedQuiz.key_insights && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4" />
                        Key Insights
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-orange-50 p-3 rounded">{selectedQuiz.key_insights}</pre>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="pt-4 border-t space-y-2">
                    <button 
                      onClick={() => downloadHTML(selectedQuiz)}
                      className="w-full px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex items-center justify-center gap-2"
                    >
                      <Code className="w-4 h-4" />
                      Download HTML Files ({selectedQuiz.html_files_count})
                    </button>
                    <button className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2">
                      <Download className="w-4 h-4" />
                      Download All Assets ({selectedQuiz.assets_count})
                    </button>
                    {selectedQuiz.url && (
                      <button
                        onClick={() => onPreview({ url: selectedQuiz.url, name: selectedQuiz.name })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2"
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