'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import {
  MessageCircle,
  X,
  Send,
  Loader2,
  Zap,
  Trash2,
  Minimize2,
  Maximize2,
  Copy,
  Check,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

const SECTION_CONTEXT: Record<string, { name: string; description: string }> = {
  '/': { name: 'Dashboard', description: 'Main dashboard with overview of all operations' },
  '/copy-analyzer': { name: 'Copy Analyzer', description: 'Analyze and improve marketing copy from URLs' },
  '/landing-analyzer': { name: 'Landing Analyzer', description: 'Deep analysis of landing pages: headlines, CTAs, structure, conversion elements' },
  '/funnel-analyzer': { name: 'Funnel Analyzer', description: 'Analyze entire sales funnels, step by step flow, upsells, downsells' },
  '/affiliate-browser-chat': { name: 'Affiliate Browser Chat', description: 'AI agent that browses the web to research affiliate offers and funnels' },
  '/my-funnels': { name: 'My Funnels', description: 'Saved funnels from crawls, with flow visualization and step details' },
  '/reverse-funnel': { name: 'Reverse Funnel', description: 'Reverse-engineer competitor funnels from a URL' },
  '/front-end-funnel': { name: 'Front End Funnel', description: 'Build front-end funnel step by step: bridge pages, VSLs, presell pages, each with clone & swipe' },
  '/post-purchase': { name: 'Post Purchase Funnel', description: 'Build post-purchase funnel: upsells, downsells, order bumps, thank you pages' },
  '/templates': { name: 'My Archive', description: 'Saved funnel templates and pages organized by type, with AI analysis per category' },
  '/products': { name: 'My Products', description: 'Product catalog with name, description, price, benefits, CTA, AI-generated briefs' },
  '/quiz-creator': { name: 'Quiz Creator', description: 'Create quiz funnels for lead generation and engagement' },
  '/swipe-quiz': { name: 'Swipe Quiz', description: 'Swipe and adapt quiz templates' },
  '/agentic-swipe': { name: 'Agentic Swipe', description: 'Multi-agent pipeline for advanced swipe operations on landing pages' },
  '/clone-landing': { name: 'Clone & Swipe', description: 'Clone a landing page HTML and swipe it with AI for a different product' },
  '/prompts': { name: 'My Prompts', description: 'Saved AI prompts library for reuse across the tool' },
  '/deploy-funnel': { name: 'Deploy Funnel', description: 'Deploy funnels to external platforms like Funnelish or CheckoutChamp' },
  '/compliance-ai': { name: 'Compliance AI', description: 'Check landing pages for FTC/advertising compliance issues' },
  '/protocollo-valchiria': { name: 'Protocollo Valchiria', description: 'Strategic operations center for managing flows and products' },
  '/api-keys': { name: 'API Keys', description: 'Manage API keys for external tool integrations' },
};

function getSection(pathname: string) {
  return SECTION_CONTEXT[pathname] || { name: 'Tool', description: 'Funnel Swiper tool' };
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const STORAGE_KEY = 'openclaw_chat_history';
const MAX_STORED_MESSAGES = 50;

function loadMessages(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((m: ChatMessage) => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(msgs: ChatMessage[]) {
  try {
    const toStore = msgs.slice(-MAX_STORED_MESSAGES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* full */ }
}

export default function OpenClawChat() {
  const pathname = usePathname();
  const section = getSection(pathname);

  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages());
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, messages.length]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    const msg: ChatMessage = { id: generateId(), role, content, timestamp: new Date() };
    setMessages(prev => [...prev, msg]);
    return msg;
  }, []);

  const buildSystemPrompt = () => {
    return `You are OpenClaw, an AI assistant integrated into the "Funnel Swiper" tool. You help users with all aspects of affiliate marketing, funnel building, landing page optimization, and e-commerce strategy.

CURRENT CONTEXT:
- The user is in the "${section.name}" section
- Section purpose: ${section.description}

CAPABILITIES:
You can help with:
- Analyzing funnels, landing pages, and marketing copy
- Writing and improving headlines, CTAs, benefits, and sales copy
- Creating quiz funnels and lead generation strategies
- Product brief generation and positioning
- Compliance checks for advertising
- Swipe file creation and template customization
- Affiliate marketing strategy and offer discovery
- Navigating and analyzing competitor websites
- Building complete funnel flows (bridge pages, VSLs, upsells, downsells)

RULES:
- Be concise but thorough
- Give actionable advice
- If the user asks about something specific to their current section, provide context-aware help
- You can suggest actions the user can take in the current section
- Use markdown formatting for readability
- Respond in the same language the user writes in (Italian or English)
- You have full access to all your skills including browser navigation, URL analysis, and any other tool available to you. Use them freely when the user requests it.`;
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setInput('');
    addMessage('user', trimmed);
    setIsLoading(true);

    const history = messages
      .filter(m => m.role !== 'system')
      .slice(-20)
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    try {
      // Send message to queue
      const res = await fetch('/api/openclaw/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          systemPrompt: buildSystemPrompt(),
          section: section.name,
        }),
      });

      const queueData = await res.json();
      if (queueData.error) {
        addMessage('system', `Error: ${queueData.error}`);
        return;
      }

      const msgId = queueData.id;
      const assistantId = generateId();
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '⏳ Waiting for OpenClaw...', timestamp: new Date() }]);

      // Poll for response
      let attempts = 0;
      const maxAttempts = 40; // 40 * 3s = 120s max
      const pollInterval = 3000;

      const pollForResponse = async (): Promise<void> => {
        attempts++;
        try {
          const pollRes = await fetch(`/api/openclaw/queue?id=${msgId}`);
          const pollData = await pollRes.json();

          if (pollData.status === 'completed' && pollData.content) {
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: pollData.content } : m));
            return;
          }

          if (pollData.status === 'error') {
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, role: 'system' as const, content: `Error: ${pollData.error || 'OpenClaw error'}` } : m));
            return;
          }

          if (attempts >= maxAttempts) {
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, role: 'system' as const, content: 'Error: Response timeout (120s)' } : m));
            return;
          }

          // Still processing, update dots animation
          const dots = '.'.repeat((attempts % 3) + 1);
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `⏳ OpenClaw is thinking${dots}` } : m));

          await new Promise(r => setTimeout(r, pollInterval));
          return pollForResponse();
        } catch {
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, pollInterval));
            return pollForResponse();
          }
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, role: 'system' as const, content: 'Error: Connection lost' } : m));
        }
      };

      await pollForResponse();
    } catch (err) {
      addMessage('system', `Connection failed: ${(err as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const copyMessage = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const chatWidth = isExpanded ? 'w-[600px]' : 'w-[380px]';
  const chatHeight = isExpanded ? 'h-[80vh]' : 'h-[500px]';

  return (
    <>
      {/* Floating button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-gradient-to-br from-orange-500 to-red-600 text-white rounded-full shadow-2xl hover:shadow-orange-500/30 hover:scale-110 transition-all flex items-center justify-center group"
        >
          <Zap className="w-6 h-6 group-hover:scale-110 transition-transform" />
          {messages.length > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {messages.filter(m => m.role === 'assistant').length}
            </span>
          )}
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div className={`fixed bottom-6 right-6 z-50 ${chatWidth} ${chatHeight} bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden transition-all duration-200`}>
          {/* Header */}
          <div className="bg-gradient-to-r from-orange-500 to-red-600 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-white" />
              <div>
                <h3 className="text-white font-semibold text-sm">OpenClaw</h3>
                <p className="text-white/70 text-[10px]">{section.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={clearChat}
                className="p-1.5 text-white/70 hover:text-white hover:bg-white/20 rounded-lg transition-colors"
                title="Clear chat"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 text-white/70 hover:text-white hover:bg-white/20 rounded-lg transition-colors"
                title={isExpanded ? 'Minimize' : 'Expand'}
              >
                {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 text-white/70 hover:text-white hover:bg-white/20 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-8">
                <Zap className="w-10 h-10 text-orange-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm font-medium">OpenClaw ready</p>
                <p className="text-gray-400 text-xs mt-1">Ask me anything about {section.name}</p>
                <div className="mt-4 space-y-2">
                  {[
                    `What can I do in ${section.name}?`,
                    'Analyze the copy of https://example.com',
                    'Clone the landing page at https://example.com',
                    'Check compliance of https://example.com',
                    'Create a product called "My Product"',
                  ].slice(0, 3).map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                      className="block w-full text-left px-3 py-2 bg-gray-50 hover:bg-orange-50 rounded-lg text-xs text-gray-600 hover:text-orange-700 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`relative group max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                    msg.role === 'user'
                      ? 'bg-orange-500 text-white rounded-br-md'
                      : msg.role === 'system'
                      ? 'bg-red-50 text-red-700 rounded-bl-md border border-red-100'
                      : 'bg-gray-100 text-gray-800 rounded-bl-md'
                  }`}
                >
                  <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{msg.content}</div>
                  {msg.role === 'assistant' && (
                    <button
                      onClick={() => copyMessage(msg.id, msg.content)}
                      className="absolute -bottom-2 right-2 opacity-0 group-hover:opacity-100 bg-white border border-gray-200 rounded-full p-1 shadow-sm transition-opacity"
                    >
                      {copiedId === msg.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3 text-gray-400" />}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-orange-500 animate-spin" />
                    <span className="text-xs text-gray-500">OpenClaw is thinking...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-gray-100 p-3 shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Ask OpenClaw about ${section.name}...`}
                rows={1}
                className="flex-1 resize-none px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent max-h-24"
                style={{ minHeight: '42px' }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="p-2.5 bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-xl hover:from-orange-600 hover:to-red-700 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed transition-all shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
