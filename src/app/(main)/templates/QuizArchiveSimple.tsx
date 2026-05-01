'use client';

import { useState, useEffect } from 'react';
import { HelpCircle, Eye, Tag, FileCode, Layers, Plus, ChevronDown, ChevronUp, ExternalLink, Monitor, Smartphone, Copy } from 'lucide-react';

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
  const [expandedQuiz, setExpandedQuiz] = useState<string | null>(null);

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

  const getQuizColor = (name: string) => {
    const colors = {
      'Bioma': 'from-green-500 to-emerald-600',
      'Terrashell': 'from-blue-500 to-indigo-600',
      'Mounjaro': 'from-purple-500 to-pink-600',
      'Magnetmind': 'from-indigo-500 to-purple-600',
      'Bliz-german': 'from-gray-700 to-gray-900'
    };
    return colors[name] || 'from-orange-500 to-red-600';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Quiz Archive</h2>
          <p className="text-sm text-gray-500 mt-1">
            Complete analysis of {quizzes.length} competitor quiz funnels
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

      <div className="space-y-4">
        {filteredQuizzes.map((quiz) => (
          <div 
            key={quiz.id} 
            className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-all"
          >
            {/* Quiz Header */}
            <div 
              className={`bg-gradient-to-r ${getQuizColor(quiz.name)} p-5 cursor-pointer`}
              onClick={() => setExpandedQuiz(expandedQuiz === quiz.id ? null : quiz.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white/20 rounded-lg flex items-center justify-center">
                    <HelpCircle className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white">{quiz.name}</h3>
                    <div className="flex items-center gap-4 mt-1">
                      <span className="text-white/80 text-sm flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5" />
                        {quiz.total_steps || Math.floor(quiz.screenshots_count / 2)} steps
                      </span>
                      <span className="text-white/80 text-sm flex items-center gap-1">
                        <Monitor className="w-3.5 h-3.5" />
                        {quiz.screenshots_count} screens
                      </span>
                      <span className="text-white/80 text-sm flex items-center gap-1">
                        <FileCode className="w-3.5 h-3.5" />
                        {quiz.html_files_count} HTML
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {quiz.url && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreview({ url: quiz.url, name: quiz.name });
                      }}
                      className="px-3 py-1.5 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" />
                      View Live
                    </button>
                  )}
                  {expandedQuiz === quiz.id ? (
                    <ChevronUp className="w-5 h-5 text-white" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-white" />
                  )}
                </div>
              </div>
            </div>

            {/* Expanded Content */}
            {expandedQuiz === quiz.id && (
              <div className="p-6 space-y-6">
                {/* Overview */}
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">Overview</h4>
                  <p className="text-gray-600 whitespace-pre-wrap">{quiz.overview}</p>
                </div>

                {/* Analysis Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Target Audience */}
                  {quiz.target_audience && (
                    <div className="bg-gray-50 rounded-lg p-4">
                      <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Tag className="w-4 h-4 text-gray-500" />
                        Target Audience
                      </h4>
                      <p className="text-sm text-gray-600">{quiz.target_audience}</p>
                    </div>
                  )}

                  {/* Quiz Structure */}
                  {quiz.quiz_structure && (
                    <div className="bg-blue-50 rounded-lg p-4">
                      <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Layers className="w-4 h-4 text-blue-500" />
                        Quiz Structure
                      </h4>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{quiz.quiz_structure}</p>
                    </div>
                  )}

                  {/* Copy Patterns */}
                  {quiz.copy_patterns && (
                    <div className="bg-green-50 rounded-lg p-4">
                      <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Copy className="w-4 h-4 text-green-500" />
                        Copy Patterns
                      </h4>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{quiz.copy_patterns}</p>
                    </div>
                  )}

                  {/* Key Insights */}
                  {quiz.key_insights && (
                    <div className="bg-orange-50 rounded-lg p-4">
                      <h4 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                        <Eye className="w-4 h-4 text-orange-500" />
                        Key Insights
                      </h4>
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{quiz.key_insights}</p>
                    </div>
                  )}
                </div>

                {/* Technical Notes */}
                {quiz.technical_notes && (
                  <div>
                    <h4 className="font-semibold text-gray-900 mb-2">Technical Implementation</h4>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-4">{quiz.technical_notes}</p>
                  </div>
                )}

                {/* Local Path */}
                <div className="bg-gray-100 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-900 mb-2">Local Files</h4>
                  <code className="text-xs text-gray-600 break-all">{quiz.local_path}</code>
                  <div className="mt-2 text-xs text-gray-500">
                    Contains {quiz.screenshots_count} screenshots, {quiz.html_files_count} HTML files, and {quiz.assets_count} other assets
                  </div>
                </div>

                {/* Tags */}
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">Tags</h4>
                  <div className="flex flex-wrap gap-2">
                    {quiz.tags.map((tag, i) => (
                      <span key={i} className="px-3 py-1 bg-gray-200 text-gray-700 rounded-full text-sm">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {filteredQuizzes.length === 0 && (
        <div className="text-center py-16">
          <HelpCircle className="w-16 h-16 text-gray-200 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-500 mb-2">No quizzes found</h3>
          <p className="text-sm text-gray-400">
            {quizzes.length === 0 ? 'Start by scraping competitor quiz funnels' : 'Try a different search term'}
          </p>
        </div>
      )}
    </div>
  );
}