'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import {
  Brain,
  Send,
  Loader2,
  Package,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  Sparkles,
  Target,
  Palette,
  Type,
  BarChart3,
  Users,
  Megaphone,
  Layers,
  PenTool,
  Rocket,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface StrategistTopic {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  question: string;
}

const STRATEGIST_TOPICS: StrategistTopic[] = [
  { id: 'angle', label: 'Angle', icon: Target, question: 'Qual è il miglior angle per questo prodotto? Analizziamo insieme i possibili angoli di attacco per il mercato.' },
  { id: 'brief', label: 'Brief', icon: PenTool, question: 'Creiamo il brief strategico per questo progetto. Di cosa abbiamo bisogno per partire?' },
  { id: 'mockup', label: 'Mockup & Layout', icon: Layers, question: 'Definiamo la struttura e il layout del funnel. Come deve essere organizzata ogni pagina?' },
  { id: 'colors', label: 'Colori & Brand', icon: Palette, question: 'Definiamo la palette colori e l\'identità visiva del brand. Che sensazione vogliamo trasmettere?' },
  { id: 'tov', label: 'Tone of Voice', icon: Type, question: 'Qual è il tone of voice giusto per questo progetto? Formale, colloquiale, urgente, empatico?' },
  { id: 'copy', label: 'Copy & Headlines', icon: Megaphone, question: 'Lavoriamo sulla copy: headline, sub-headline, CTA e testi persuasivi per ogni step del funnel.' },
  { id: 'funnel', label: 'Strategia Funnel', icon: BarChart3, question: 'Progettiamo l\'architettura completa del funnel: landing, checkout, upsell, downsell, thank you page.' },
  { id: 'audience', label: 'Pubblico Target', icon: Users, question: 'Definiamo il pubblico target: chi sono, dove li troviamo, quali sono i loro problemi e desideri.' },
  { id: 'launch', label: 'Piano Lancio', icon: Rocket, question: 'Pianifichiamo il lancio: timeline, canali, budget, creatività, metriche di successo.' },
];

const STORAGE_KEY = 'strategist_chat_history';
const PRODUCT_KEY = 'strategist_selected_product';
const MAX_STORED_MESSAGES = 100;

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadMessages(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((m: ChatMessage) => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(msgs: ChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-MAX_STORED_MESSAGES)));
  } catch { /* storage full */ }
}

function loadSelectedProduct(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(PRODUCT_KEY) || '';
}

export default function StrategistPage() {
  const { products, funnelPages, isInitialized, initialize } = useStore();

  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages());
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string>(() => loadSelectedProduct());
  const [showTopics, setShowTopics] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (selectedProduct) {
      localStorage.setItem(PRODUCT_KEY, selectedProduct);
    } else {
      localStorage.removeItem(PRODUCT_KEY);
    }
  }, [selectedProduct]);

  const product = products.find((p) => p.id === selectedProduct);

  const buildSystemPrompt = () => {
    let productContext = '';
    if (product) {
      productContext = `\n\nPRODOTTO SELEZIONATO:
- Nome: ${product.name}
- Prezzo: €${product.price}
- Descrizione: ${product.description || 'N/A'}
- Brand: ${product.brandName || 'N/A'}
- Categoria: ${product.category || 'N/A'}
- Benefici: ${product.benefits?.join(', ') || 'N/A'}
- CTA: ${product.ctaText || 'N/A'}
- Caratteristiche: ${product.characteristics?.join(', ') || 'N/A'}
- Geo/Mercato: ${product.geoMarket || 'N/A'}`;
    }

    let funnelContext = '';
    if (funnelPages.length > 0) {
      const pages = funnelPages
        .filter((p) => !selectedProduct || p.productId === selectedProduct)
        .slice(0, 15)
        .map((p) => `- ${p.name} (${p.pageType})${p.urlToSwipe ? ` → ${p.urlToSwipe}` : ''}`)
        .join('\n');
      if (pages) {
        funnelContext = `\n\nPAGINE FUNNEL GIA' CREATE:\n${pages}`;
      }
    }

    return `Sei lo Strategist AI di "Funnel Swiper", un esperto di livello mondiale in direct response marketing, funnel building e affiliate marketing. Il tuo ruolo è guidare l'utente nella creazione di una strategia completa per il lancio di un prodotto/offerta.

COME LAVORI:
- Guidi l'utente passo dopo passo attraverso ogni aspetto strategico
- Fai domande per capire meglio il contesto prima di dare raccomandazioni
- Sei specifico e pratico: ogni suggerimento deve essere actionable
- Usi la tua esperienza per proporre soluzioni concrete, non generiche
- Quando l'utente sceglie un topic (angle, brief, mockup, colori, tov, copy, funnel, audience, lancio), approfondisci quel tema specifico
- Tieni sempre in considerazione il prodotto selezionato e i dati disponibili

AREE DI COMPETENZA:
1. ANGLE: Angoli di attacco per il mercato, positioning, unique mechanism
2. BRIEF: Documento strategico con obiettivi, target, messaging
3. MOCKUP & LAYOUT: Struttura pagine, wireframe concettuale, flow visivo
4. COLORI & BRAND: Palette colori, identità visiva, logo concept, mood board
5. TONE OF VOICE: Stile comunicativo, registro linguistico, personalità del brand
6. COPY: Headlines, sub-headlines, body copy, CTA, email sequences
7. STRATEGIA FUNNEL: Architettura completa (landing→checkout→upsell→downsell→TY)
8. PUBBLICO TARGET: Buyer persona, segmentazione, pain points, desires
9. PIANO LANCIO: Timeline, canali, budget, creatività, KPI, scaling

REGOLE:
- Rispondi SEMPRE in italiano
- Usa formattazione markdown per chiarezza (titoli, elenchi, grassetto)
- Sii proattivo: suggerisci il prossimo step da affrontare
- Quando dai opzioni, numerale per facilitare la scelta
- Se mancano informazioni chiedi all'utente, non inventare${productContext}${funnelContext}`;
  };

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    const msg: ChatMessage = { id: generateId(), role, content, timestamp: new Date() };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const sendToOpenClaw = async (userText: string) => {
    if (isLoading) return;
    setIsLoading(true);

    const chatHistory = messages
      .filter((m) => m.role !== 'system')
      .slice(-30)
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    try {
      const res = await fetch('/api/openclaw/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          systemPrompt: buildSystemPrompt(),
          section: 'Strategist',
          chatHistory,
        }),
      });

      const queueData = await res.json();
      if (queueData.error) {
        addMessage('system', `Errore: ${queueData.error}`);
        return;
      }

      const msgId = queueData.id;
      const assistantId = generateId();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '⏳ Strategist sta elaborando...', timestamp: new Date() },
      ]);

      let attempts = 0;
      const maxAttempts = 600;
      const pollInterval = 3000;

      const poll = async (): Promise<void> => {
        attempts++;
        try {
          const pollRes = await fetch(`/api/openclaw/queue?id=${msgId}`);
          const pollData = await pollRes.json();

          if (pollData.status === 'completed' && pollData.content) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: pollData.content } : m))
            );
            return;
          }

          if (pollData.status === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, role: 'system' as const, content: `Errore: ${pollData.error || 'Errore OpenClaw'}` }
                  : m
              )
            );
            return;
          }

          if (attempts >= maxAttempts) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, role: 'system' as const, content: 'Errore: Timeout risposta (30min)' }
                  : m
              )
            );
            return;
          }

          const dots = '.'.repeat((attempts % 3) + 1);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: `⏳ Strategist sta elaborando${dots}` } : m
            )
          );

          await new Promise((r) => setTimeout(r, pollInterval));
          return poll();
        } catch {
          if (attempts < maxAttempts) {
            await new Promise((r) => setTimeout(r, pollInterval));
            return poll();
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, role: 'system' as const, content: 'Errore: Connessione persa' }
                : m
            )
          );
        }
      };

      await poll();
    } catch (err) {
      addMessage('system', `Connessione fallita: ${(err as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput('');
    addMessage('user', trimmed);
    sendToOpenClaw(trimmed);
  };

  const handleTopicClick = (topic: StrategistTopic) => {
    setShowTopics(false);
    const text = product
      ? `${topic.question}\n\nProdotto: ${product.name} (€${product.price})`
      : topic.question;
    addMessage('user', text);
    sendToOpenClaw(text);
  };

  const handleStartSession = () => {
    if (!product) return;
    const intro = `Ciao! Ho selezionato il prodotto "${product.name}" (€${product.price}). Voglio costruire una strategia completa per questo prodotto. Guidami passo dopo passo partendo dall'analisi iniziale.${product.description ? `\n\nDescrizione: ${product.description}` : ''}${product.benefits?.length ? `\nBenefici: ${product.benefits.join(', ')}` : ''}${product.category ? `\nCategoria: ${product.category}` : ''}`;
    addMessage('user', intro);
    sendToOpenClaw(intro);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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

  const hasMessages = messages.length > 0;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header title="Strategist" subtitle="AI-powered funnel strategy planner" />

      <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-6 py-4">
        {/* Top bar: Product + Actions */}
        <div className="flex items-center gap-3 mb-4">
          {/* Product selector */}
          <div className="flex-1 flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-xl shadow-md">
              <Brain className="w-5 h-5 text-white" />
            </div>

            <div className="relative flex-1 max-w-sm">
              <select
                value={selectedProduct}
                onChange={(e) => setSelectedProduct(e.target.value)}
                className="w-full appearance-none pl-10 pr-10 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-800 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 shadow-sm cursor-pointer"
              >
                <option value="">Seleziona un prodotto...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.price > 0 ? `— €${p.price}` : ''}
                  </option>
                ))}
              </select>
              <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>

            {product && (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-medium rounded-full border border-indigo-200">
                <Sparkles className="w-3 h-3" />
                {product.category || product.brandName || 'Prodotto attivo'}
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {/* Topic shortcut */}
            <div className="relative">
              <button
                onClick={() => setShowTopics(!showTopics)}
                disabled={isLoading}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50"
              >
                <Target className="w-4 h-4 text-indigo-500" />
                <span className="hidden sm:inline">Topic</span>
              </button>

              {showTopics && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-xl border border-gray-200 shadow-2xl z-50 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
                    <p className="text-xs font-semibold text-gray-500 uppercase">Scegli un topic strategico</p>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {STRATEGIST_TOPICS.map((topic) => {
                      const Icon = topic.icon;
                      return (
                        <button
                          key={topic.id}
                          onClick={() => handleTopicClick(topic)}
                          className="w-full text-left px-4 py-3 hover:bg-indigo-50 transition-colors flex items-center gap-3 border-b border-gray-50 last:border-0"
                        >
                          <Icon className="w-4 h-4 text-indigo-500 shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-gray-800">{topic.label}</p>
                            <p className="text-xs text-gray-400 line-clamp-1">{topic.question}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {hasMessages && (
              <button
                onClick={clearChat}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 shadow-sm transition-colors"
                title="Nuova sessione"
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">Reset</span>
              </button>
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col overflow-hidden min-h-[500px]">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Empty state */}
            {!hasMessages && (
              <div className="flex flex-col items-center justify-center h-full py-12">
                <div className="p-5 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl mb-5">
                  <Brain className="w-12 h-12 text-indigo-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Strategist AI</h3>
                <p className="text-gray-500 text-sm text-center max-w-md mb-6">
                  Seleziona un prodotto e inizia una sessione strategica. Ti guider&ograve; nella definizione di
                  angle, brief, mockup, colori, tone of voice, copy, strategia funnel, target e piano lancio.
                </p>

                {product ? (
                  <div className="space-y-4 w-full max-w-md">
                    <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-3">
                      <Package className="w-5 h-5 text-indigo-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900 text-sm">{product.name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {product.price > 0 ? `€${product.price}` : ''} {product.category ? `• ${product.category}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={handleStartSession}
                        disabled={isLoading}
                        className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:bg-gray-300 shrink-0 flex items-center gap-2"
                      >
                        <Rocket className="w-4 h-4" />
                        Inizia
                      </button>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {STRATEGIST_TOPICS.slice(0, 9).map((topic) => {
                        const Icon = topic.icon;
                        return (
                          <button
                            key={topic.id}
                            onClick={() => handleTopicClick(topic)}
                            disabled={isLoading}
                            className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 transition-all text-center disabled:opacity-50"
                          >
                            <Icon className="w-5 h-5 text-indigo-500" />
                            <span className="text-xs font-medium text-gray-700">{topic.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 max-w-sm text-center">
                    <Package className="w-6 h-6 text-amber-500 mx-auto mb-2" />
                    <p className="text-sm text-amber-800 font-medium">Seleziona un prodotto</p>
                    <p className="text-xs text-amber-600 mt-1">
                      Scegli un prodotto dal menu in alto per iniziare la sessione strategica
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Messages */}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`relative group max-w-[80%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-md'
                      : msg.role === 'system'
                      ? 'bg-red-50 text-red-700 rounded-bl-md border border-red-200'
                      : 'bg-gray-50 text-gray-800 rounded-bl-md border border-gray-200'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-200">
                      <Brain className="w-3.5 h-3.5 text-indigo-500" />
                      <span className="text-[11px] font-semibold text-indigo-600">Strategist AI</span>
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {msg.content}
                  </div>
                  {msg.role === 'assistant' && msg.content && !msg.content.startsWith('⏳') && (
                    <button
                      onClick={() => copyMessage(msg.id, msg.content)}
                      className="absolute -bottom-2 right-3 opacity-0 group-hover:opacity-100 bg-white border border-gray-200 rounded-full p-1.5 shadow-sm transition-opacity"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3 h-3 text-green-600" />
                      ) : (
                        <Copy className="w-3 h-3 text-gray-400" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}

            <div ref={messagesEndRef} />
          </div>

          {/* Input bar */}
          <div className="border-t border-gray-100 p-4 bg-gray-50/50">
            {/* Quick topic chips (visible when chat is active) */}
            {hasMessages && !isLoading && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {STRATEGIST_TOPICS.map((topic) => {
                  const Icon = topic.icon;
                  return (
                    <button
                      key={topic.id}
                      onClick={() => handleTopicClick(topic)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors"
                    >
                      <Icon className="w-3 h-3" />
                      {topic.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex items-end gap-3">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isLoading
                    ? 'Strategist sta elaborando...'
                    : product
                    ? `Chiedi allo Strategist su ${product.name}...`
                    : 'Seleziona un prodotto per iniziare...'
                }
                disabled={isLoading}
                rows={1}
                className="flex-1 resize-none px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed max-h-32"
                style={{ minHeight: '48px' }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="p-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed transition-all shadow-sm shrink-0"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
