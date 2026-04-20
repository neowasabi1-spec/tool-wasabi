'use client';

import { useState, useEffect } from 'react';
import { HelpCircle, Eye, Tag, FileCode, Layers, Plus } from 'lucide-react';

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

  useEffect(() => {
    fetchQuizzes();
  }, []);

  const fetchQuizzes = async () => {
    try {
      console.log('Fetching quiz archive...');
      const response = await fetch('/api/quiz-archive');
      const data = await response.json();
      console.log('Quiz archive data:', data);
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
          Add New Quiz
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
          {/* Create from Scratch card */}
          <button
            onClick={onAddNew}
            className="border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center py-16 hover:border-gray-400 hover:bg-gray-50 transition-all group min-h-[360px]"
          >
            <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4 group-hover:bg-gray-200 transition-colors">
              <Plus className="w-7 h-7 text-gray-400 group-hover:text-gray-600" />
            </div>
            <span className="text-sm font-bold text-gray-700">Create from Scratch</span>
            <span className="text-xs text-gray-400 mt-1">Start with a blank quiz funnel</span>
          </button>

          {/* Scraped Quizzes */}
          {filteredQuizzes.map((quiz) => (
            <div 
              key={quiz.id} 
              className="bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-xl transition-all group relative cursor-pointer"
              onClick={() => setSelectedQuiz(quiz)}
            >
              <div className="relative">
                <div className="h-[200px] bg-gradient-to-br from-orange-100 to-amber-100 flex items-center justify-center">
                  <HelpCircle className="w-16 h-16 text-orange-300" />
                </div>
                <div className="absolute top-3 left-3 flex items-center gap-2">
                  <span className="px-3 py-1 bg-orange-500/90 text-white rounded-lg text-xs font-semibold shadow-sm">
                    Scraped Quiz
                  </span>
                  <span className="px-3 py-1 bg-white/90 backdrop-blur-sm rounded-lg text-xs font-semibold text-gray-800 shadow-sm">
                    {quiz.total_steps} steps
                  </span>
                </div>
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview({ url: quiz.url, name: quiz.name });
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-lg text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
                  >
                    <Eye className="w-4 h-4" /> Preview Original
                  </button>
                </div>
              </div>

              <div className="p-5">
                <h3 className="font-bold text-gray-900 text-base mb-2">{quiz.name}</h3>
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{quiz.overview}</p>
                
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-3 text-gray-500">
                    <span className="flex items-center gap-1">
                      <FileCode className="w-3.5 h-3.5" />
                      {quiz.screenshots_count} screenshots
                    </span>
                    <span className="flex items-center gap-1">
                      <Layers className="w-3.5 h-3.5" />
                      {quiz.assets_count} assets
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1 mt-3">
                  {quiz.tags.slice(0, 3).map((tag, i) => (
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

      {/* Detail Modal */}
      {selectedQuiz && (
        <div 
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedQuiz(null)}
        >
          <div 
            className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-2xl font-bold">{selectedQuiz.name}</h2>
                <a 
                  href={selectedQuiz.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  {selectedQuiz.url}
                </a>
              </div>
              <button
                onClick={() => setSelectedQuiz(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="grid grid-cols-4 gap-4 mb-6 text-center">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-gray-900">{selectedQuiz.total_steps}</div>
                <div className="text-xs text-gray-500">Steps</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-gray-900">{selectedQuiz.screenshots_count}</div>
                <div className="text-xs text-gray-500">Screenshots</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-gray-900">{selectedQuiz.html_files_count}</div>
                <div className="text-xs text-gray-500">HTML Files</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-gray-900">{selectedQuiz.assets_count}</div>
                <div className="text-xs text-gray-500">Assets</div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Overview</h3>
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{selectedQuiz.overview}</p>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Local Files</h3>
                <p className="text-sm font-mono bg-gray-100 p-2 rounded">{selectedQuiz.local_path}</p>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Tags</h3>
                <div className="flex flex-wrap gap-2">
                  {selectedQuiz.tags.map((tag, i) => (
                    <span key={i} className="px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-sm">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Scraped Date</h3>
                <p className="text-sm text-gray-600">
                  {new Date(selectedQuiz.scraped_at || selectedQuiz.created_at).toLocaleString()}
                </p>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  onPreview({ url: selectedQuiz.url, name: selectedQuiz.name });
                  setSelectedQuiz(null);
                }}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Eye className="w-4 h-4" />
                View Original Quiz
              </button>
              <button
                onClick={() => setSelectedQuiz(null)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}