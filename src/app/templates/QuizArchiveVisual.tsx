'use client';

import { useState, useEffect } from 'react';
import { HelpCircle, Eye, Tag, FileCode, Layers, Plus, ChevronRight, ChevronLeft, X, Monitor, Smartphone, Copy, ExternalLink, Download, Sparkles } from 'lucide-react';

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

  // Mock screenshot data for visual representation
  const getQuizMockScreens = (quiz: string) => {
    const screens = {
      'Bioma': {
        color: 'from-green-400 to-emerald-500',
        steps: [
          { title: 'Welcome', desc: 'Personal health journey' },
          { title: 'Demographics', desc: 'Age, gender, location' },
          { title: 'Health Goals', desc: 'What brings you here?' },
          { title: 'Body Areas', desc: 'Visual body selection' },
          { title: 'Symptoms', desc: 'Check all that apply' },
          { title: 'Lifestyle', desc: 'Daily habits assessment' }
        ]
      },
      'Terrashell': {
        color: 'from-blue-400 to-indigo-500',
        steps: [
          { title: 'Security Check', desc: 'Analyzing your device' },
          { title: 'Shopping Habits', desc: 'How often do you shop?' },
          { title: 'Card Selection', desc: 'Visual card interface' },
          { title: 'Protection Level', desc: 'Current security status' }
        ]
      },
      'Mounjaro': {
        color: 'from-purple-400 to-pink-500',
        steps: [
          { title: 'Weight Goal', desc: 'How much to lose?' },
          { title: 'Medication', desc: 'Current prescriptions' },
          { title: 'Get Results', desc: 'Enter email for plan' }
        ]
      },
      'Magnetmind': {
        color: 'from-indigo-400 to-purple-500',
        steps: [
          { title: 'Stress Level', desc: 'Rate your stress' },
          { title: 'Experience', desc: 'Meditation background' },
          { title: 'Goals', desc: 'What do you seek?' },
          { title: 'Preferences', desc: 'Music, time, style' }
        ]
      },
      'Bliz-german': {
        color: 'from-gray-600 to-gray-800',
        steps: [
          { title: 'Willkommen', desc: 'German market quiz' },
          { title: 'Gewichtsziel', desc: 'Weight loss goals' },
          { title: 'Gesundheit', desc: 'Health conditions' },
          { title: 'Produkt', desc: 'Product matching' }
        ]
      }
    };
    
    return screens[quiz] || { color: 'from-orange-400 to-red-500', steps: [] };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Quiz Archive</h2>
          <p className="text-sm text-gray-500 mt-1">
            Visual analysis of {quizzes.length} competitor quiz funnels
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
          const mockData = getQuizMockScreens(quiz.name);
          
          return (
            <div 
              key={quiz.id} 
              className="bg-white rounded-xl shadow-md hover:shadow-xl transition-all cursor-pointer overflow-hidden group"
              onClick={() => {
                setSelectedQuiz(quiz);
                setCurrentStep(1);
              }}
            >
              {/* Visual Preview */}
              <div className={`h-48 bg-gradient-to-br ${mockData.color} relative overflow-hidden`}>
                {/* Mock screens grid */}
                <div className="absolute inset-0 p-4">
                  <div className="grid grid-cols-2 gap-2 h-full">
                    {mockData.steps.slice(0, 4).map((step, i) => (
                      <div 
                        key={i} 
                        className="bg-white/20 backdrop-blur-sm rounded-lg p-3 flex flex-col justify-center"
                      >
                        <div className="text-white/90 text-xs font-semibold">{step.title}</div>
                        <div className="text-white/60 text-[10px] mt-0.5">{step.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <div className="text-white text-center">
                    <Eye className="w-8 h-8 mx-auto mb-2" />
                    <span className="text-sm font-medium">View Analysis</span>
                  </div>
                </div>
              </div>

              {/* Card Content */}
              <div className="p-5">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-bold text-gray-900 text-lg">{quiz.name}</h3>
                  {quiz.url && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreview({ url: quiz.url, name: quiz.name });
                      }}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                  )}
                </div>
                
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{quiz.overview}</p>
                
                {/* Stats */}
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{quiz.total_steps || Math.floor(quiz.screenshots_count / 2)} steps</span>
                  <span>{quiz.screenshots_count} screenshots</span>
                  <span>{quiz.assets_count} assets</span>
                </div>

                {/* Tags */}
                <div className="flex flex-wrap gap-1 mt-3">
                  {quiz.tags.slice(0, 3).map((tag, i) => (
                    <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                      {tag}
                    </span>
                  ))}
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
            <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">{selectedQuiz.name} Quiz Analysis</h2>
                <p className="text-sm text-gray-500 mt-1">{selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2)} steps • {selectedQuiz.screenshots_count} screenshots</p>
              </div>
              <button
                onClick={() => setSelectedQuiz(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 flex overflow-hidden">
              {/* Left Panel - Visual Flow */}
              <div className="flex-1 bg-gray-50 p-6 overflow-y-auto">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-semibold">Quiz Flow Visualization</h3>
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
                  <div className="flex items-center justify-between mb-4">
                    <button
                      onClick={() => setCurrentStep(Math.max(1, currentStep - 1))}
                      disabled={currentStep === 1}
                      className="p-2 hover:bg-gray-100 rounded disabled:opacity-50"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <div className="text-center">
                      <div className="text-sm text-gray-500">Step {currentStep} of {selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2)}</div>
                      <div className="font-semibold">{getQuizMockScreens(selectedQuiz.name).steps[currentStep - 1]?.title || `Step ${currentStep}`}</div>
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

                {/* Mock Screen */}
                <div className={`mx-auto ${viewMode === 'mobile' ? 'max-w-sm' : 'max-w-2xl'}`}>
                  <div className={`bg-white rounded-lg shadow-lg overflow-hidden ${viewMode === 'mobile' ? 'aspect-[9/16]' : 'aspect-[16/9]'}`}>
                    <div className={`h-full bg-gradient-to-br ${getQuizMockScreens(selectedQuiz.name).color} p-8 flex flex-col items-center justify-center text-white`}>
                      <FileCode className="w-16 h-16 mb-4 opacity-50" />
                      <h4 className="text-xl font-semibold mb-2">
                        {getQuizMockScreens(selectedQuiz.name).steps[currentStep - 1]?.title || `Step ${currentStep}`}
                      </h4>
                      <p className="text-sm opacity-80">
                        {getQuizMockScreens(selectedQuiz.name).steps[currentStep - 1]?.desc || 'Quiz step content'}
                      </p>
                      <div className="mt-6 text-xs opacity-60">
                        {viewMode === 'mobile' ? 'Mobile View' : 'Desktop View'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 text-center text-xs text-gray-500">
                    Screenshot path: {selectedQuiz.local_path}/screenshots/step-{currentStep - 1}-{viewMode}.png
                  </div>
                </div>

                {/* Step Thumbnails */}
                <div className="mt-6">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">All Steps</h4>
                  <div className="grid grid-cols-6 gap-2">
                    {Array.from({ length: selectedQuiz.total_steps || Math.floor(selectedQuiz.screenshots_count / 2) }).map((_, i) => (
                      <button
                        key={i}
                        onClick={() => setCurrentStep(i + 1)}
                        className={`aspect-[3/4] rounded border-2 transition-all ${
                          currentStep === i + 1 ? 'border-orange-500 shadow-md' : 'border-gray-200'
                        } bg-gradient-to-br ${getQuizMockScreens(selectedQuiz.name).color} opacity-50 hover:opacity-75`}
                      >
                        <div className="w-full h-full flex items-center justify-center text-white font-semibold">
                          {i + 1}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right Panel - Analysis */}
              <div className="w-[450px] border-l border-gray-200 overflow-y-auto">
                <div className="p-6 space-y-6">
                  {/* Target Audience */}
                  {selectedQuiz.target_audience && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Tag className="w-4 h-4" />
                        Target Audience
                      </h3>
                      <p className="text-sm text-gray-600">{selectedQuiz.target_audience}</p>
                    </div>
                  )}

                  {/* Quiz Structure */}
                  {selectedQuiz.quiz_structure && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Layers className="w-4 h-4" />
                        Quiz Structure
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 p-3 rounded">{selectedQuiz.quiz_structure}</pre>
                    </div>
                  )}

                  {/* Copy Patterns */}
                  {selectedQuiz.copy_patterns && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Copy className="w-4 h-4" />
                        Copy Patterns
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-blue-50 p-3 rounded">{selectedQuiz.copy_patterns}</pre>
                    </div>
                  )}

                  {/* Key Insights */}
                  {selectedQuiz.key_insights && (
                    <div>
                      <h3 className="font-semibold mb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4" />
                        Key Insights
                      </h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-orange-50 p-3 rounded">{selectedQuiz.key_insights}</pre>
                    </div>
                  )}

                  {/* Technical Notes */}
                  {selectedQuiz.technical_notes && (
                    <div>
                      <h3 className="font-semibold mb-2">Technical Notes</h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 p-3 rounded">{selectedQuiz.technical_notes}</pre>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="pt-4 border-t space-y-2">
                    <button className="w-full px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 flex items-center justify-center gap-2">
                      <Download className="w-4 h-4" />
                      Download Assets ({selectedQuiz.assets_count} files)
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