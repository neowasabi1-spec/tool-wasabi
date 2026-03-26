'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import {
  X,
  Send,
  Loader2,
  Zap,
  Trash2,
  Minimize2,
  Maximize2,
  Copy,
  Check,
  Paperclip,
  Image as ImageIcon,
  FileText,
  Film,
  File,
} from 'lucide-react';

interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  textContent?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: FileAttachment[];
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
  '/strategist': { name: 'Strategist', description: 'AI-powered strategic planner: angle, brief, mockup, colors, tone of voice, copy, funnel strategy, target audience and launch plan' },
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
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = 'image/*,video/*,application/pdf,.pdf,.doc,.docx,.txt,.html,.htm,.css,.js,.json,.csv,.xlsx,.xls,.md';

function getFileIcon(type: string) {
  if (type.startsWith('image/')) return <ImageIcon className="w-4 h-4" />;
  if (type.startsWith('video/')) return <Film className="w-4 h-4" />;
  if (type === 'application/pdf' || type.includes('pdf')) return <FileText className="w-4 h-4" />;
  return <File className="w-4 h-4" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
    const toStore = msgs.slice(-MAX_STORED_MESSAGES).map(m => ({
      ...m,
      attachments: m.attachments?.map(a => ({
        ...a,
        dataUrl: a.dataUrl && a.dataUrl.length > 50000 ? undefined : a.dataUrl,
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* full */ }
}

async function readFileAsDataUrl(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
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
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/openclaw/chat', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      setConnectionStatus(data.status === 'online' ? 'online' : 'offline');
    } catch {
      setConnectionStatus('offline');
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
      checkHealth();
    }
  }, [isOpen, messages.length, checkHealth]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string, attachments?: FileAttachment[]) => {
    const msg: ChatMessage = { id: generateId(), role, content, timestamp: new Date(), attachments };
    setMessages(prev => [...prev, msg]);
    return msg;
  }, []);

  const processFiles = async (files: globalThis.File[]) => {
    const newAttachments: FileAttachment[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        addMessage('system', `File "${file.name}" is too large (max ${formatFileSize(MAX_FILE_SIZE)})`);
        continue;
      }

      const attachment: FileAttachment = {
        id: generateId(),
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
      };

      if (file.type.startsWith('image/')) {
        attachment.dataUrl = await readFileAsDataUrl(file);
      } else if (file.type.startsWith('video/')) {
        attachment.dataUrl = await readFileAsDataUrl(file);
      } else if (
        file.type === 'application/pdf' ||
        file.type.includes('text') ||
        file.name.match(/\.(txt|html|htm|css|js|json|csv|md|xml|svg)$/i)
      ) {
        attachment.textContent = await readFileAsText(file);
      } else if (file.name.match(/\.(doc|docx|xlsx|xls)$/i)) {
        attachment.textContent = `[Binary file: ${file.name} (${formatFileSize(file.size)})]`;
      } else {
        attachment.textContent = `[File: ${file.name} (${formatFileSize(file.size)})]`;
      }

      newAttachments.push(attachment);
    }

    setPendingFiles(prev => [...prev, ...newAttachments]);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) await processFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await processFiles(files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const removePendingFile = (id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  };

  const buildSystemPrompt = () => {
    return `Sei Merlino, l'AI assistant con PIENI POTERI integrato in "Funnel Swiper".

CONTESTO: Sezione "${section.name}" — ${section.description}

POTERI COMPLETI — Puoi eseguire direttamente:
- CRUD Prodotti: creare, elencare, aggiornare, eliminare
- CRUD Progetti: creare, elencare, aggiornare, eliminare
- CRUD Pagine Funnel: aggiungere, elencare, eliminare
- Clonare landing page da URL
- Swipare/riscrivere pagine per prodotti
- Analizzare landing page, copy, funnel interi
- Crawlare funnel, reverse-engineering competitor
- Generare quiz, immagini AI, brief, branding
- Check compliance FTC
- Gestire template, archivio, API keys, prompt
- Lanciare browser agent, fare screenshot
- Riscrivere copy marketing
- Deployare su Funnelish e Checkout Champ

REGOLE:
- Rispondi nella lingua dell'utente (IT/EN)
- Sii conciso ma completo, usa markdown
- Quando l'utente chiede di FARE qualcosa, eseguilo direttamente
- Analizza file caricati in dettaglio`;
  };

  const buildMessageWithAttachments = (text: string, files: FileAttachment[]): string => {
    if (files.length === 0) return text;

    let combined = text || '';
    for (const f of files) {
      if (f.textContent) {
        combined += `\n\n--- File: ${f.name} (${formatFileSize(f.size)}) ---\n${f.textContent.substring(0, 50000)}`;
      } else if (f.dataUrl && f.type.startsWith('image/')) {
        combined += `\n\n[Image attached: ${f.name} (${formatFileSize(f.size)})]`;
      } else if (f.dataUrl && f.type.startsWith('video/')) {
        combined += `\n\n[Video attached: ${f.name} (${formatFileSize(f.size)})]`;
      } else {
        combined += `\n\n[File attached: ${f.name} (${formatFileSize(f.size)})]`;
      }
    }
    return combined;
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!trimmed && !hasFiles) || isLoading) return;

    const messageText = trimmed || (hasFiles ? `Analyze ${pendingFiles.length === 1 ? 'this file' : 'these files'}` : '');
    const attachments = [...pendingFiles];

    setInput('');
    setPendingFiles([]);
    addMessage('user', messageText, attachments);
    setIsLoading(true);

    const fullMessage = buildMessageWithAttachments(messageText, attachments);

    const chatHistory = messages
      .filter(m => m.role !== 'system')
      .slice(-20)
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const allMessages = [
      ...chatHistory,
      { role: 'user', content: fullMessage },
    ];

    const payload = JSON.stringify({
      messages: allMessages,
      systemPrompt: buildSystemPrompt(),
    });

    try {
      // Step 1: Check for actions via Vercel (fast, <1s)
      const actionRes = await fetch('/api/openclaw/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      const actionText = await actionRes.text();
      let actionData;
      try {
        actionData = JSON.parse(actionText);
      } catch {
        throw new Error(`Server error (${actionRes.status}): ${actionText.substring(0, 200)}`);
      }

      if (actionData.error) {
        addMessage('system', `Error: ${actionData.error}`);
        setIsLoading(false);
        return;
      }

      // If action was executed, show result directly
      if (actionData.actionExecuted) {
        const badge = actionData.actionSuccess ? '\u2705' : '\u274C';
        addMessage('assistant', `${badge} **${actionData.actionExecuted}** ${actionData.actionSuccess ? 'eseguito' : 'fallito'}\n\n${actionData.content}`);
        setConnectionStatus('online');
        setIsLoading(false);
        return;
      }

      // Step 2: No action — call Merlino directly from browser (bypasses Vercel timeout)
      const bridgeUrl = actionData.bridgeUrl || 'http://38.247.186.84:19001';
      const merlinoRes = await fetch(`${bridgeUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: actionData.model || 'merlino',
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            ...allMessages,
          ],
          temperature: 0.7,
          max_tokens: 4096,
        }),
      });

      const merlinoData = await merlinoRes.json();
      const content = merlinoData.choices?.[0]?.message?.content || merlinoData.error || 'Nessuna risposta';

      if (merlinoData.error) {
        addMessage('system', `Merlino error: ${merlinoData.error}`);
      } else {
        addMessage('assistant', content);
      }
      setConnectionStatus('online');
    } catch (err) {
      addMessage('system', `Connessione fallita: ${(err as Error).message}`);
      setConnectionStatus('offline');
    }
    setIsLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(i => i.kind === 'file');
    if (fileItems.length === 0) return;

    e.preventDefault();
    const files = fileItems.map(i => i.getAsFile()).filter(Boolean) as globalThis.File[];
    if (files.length > 0) await processFiles(files);
  };

  const clearChat = () => {
    setMessages([]);
    setPendingFiles([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const copyMessage = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const chatWidth = isExpanded ? 'w-[600px]' : 'w-[380px]';
  const chatHeight = isExpanded ? 'h-[80vh]' : 'h-[500px]';

  const renderAttachments = (attachments: FileAttachment[]) => (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {attachments.map(a => (
        <div key={a.id} className="flex items-center gap-1 px-2 py-1 bg-white/20 rounded-lg text-[11px]">
          {a.dataUrl && a.type.startsWith('image/') ? (
            <img src={a.dataUrl} alt={a.name} className="w-16 h-16 rounded object-cover" />
          ) : (
            <>
              {getFileIcon(a.type)}
              <span className="max-w-[100px] truncate">{a.name}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        onChange={handleFileSelect}
        className="hidden"
      />

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
        <div
          className={`fixed bottom-6 right-6 z-50 ${chatWidth} ${chatHeight} bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden transition-all duration-200 ${isDragOver ? 'ring-2 ring-orange-500 ring-offset-2' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {/* Drag overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-10 bg-orange-500/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
              <div className="bg-white px-6 py-4 rounded-xl shadow-lg border-2 border-dashed border-orange-400 text-center">
                <Paperclip className="w-8 h-8 text-orange-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-gray-700">Drop files here</p>
                <p className="text-xs text-gray-400">Images, PDF, videos, documents</p>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="bg-gradient-to-r from-orange-500 to-red-600 px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-white" />
              <div>
                <div className="flex items-center gap-1.5">
                  <h3 className="text-white font-semibold text-sm">Merlino</h3>
                  <span className={`w-2 h-2 rounded-full ${connectionStatus === 'online' ? 'bg-green-400' : connectionStatus === 'offline' ? 'bg-red-400' : 'bg-yellow-400 animate-pulse'}`} title={connectionStatus} />
                </div>
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
                <p className="text-gray-500 text-sm font-medium">Merlino pronto</p>
                <p className="text-gray-400 text-xs mt-1">Chiedimi qualsiasi cosa su {section.name}</p>
                <p className="text-gray-300 text-[10px] mt-1">You can also drop files, images, or PDFs</p>
                <div className="mt-4 space-y-2">
                  {[
                    `What can I do in ${section.name}?`,
                    'Analyze the copy of https://example.com',
                    'Clone the landing page at https://example.com',
                  ].map((suggestion) => (
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
                  {msg.attachments && msg.attachments.length > 0 && renderAttachments(msg.attachments)}
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
                    <span className="text-xs text-gray-500">Merlino sta pensando...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Pending files preview */}
          {pendingFiles.length > 0 && (
            <div className="px-3 pt-2 pb-0 border-t border-gray-100 shrink-0">
              <div className="flex flex-wrap gap-2">
                {pendingFiles.map(f => (
                  <div key={f.id} className="relative group flex items-center gap-1.5 px-2 py-1.5 bg-gray-100 rounded-lg text-xs">
                    {f.dataUrl && f.type.startsWith('image/') ? (
                      <img src={f.dataUrl} alt={f.name} className="w-10 h-10 rounded object-cover" />
                    ) : (
                      <>
                        {getFileIcon(f.type)}
                        <span className="max-w-[80px] truncate">{f.name}</span>
                        <span className="text-gray-400">{formatFileSize(f.size)}</span>
                      </>
                    )}
                    <button
                      onClick={() => removePendingFile(f.id)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-gray-100 p-3 shrink-0">
            <div className="flex items-end gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2.5 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded-xl transition-colors shrink-0"
                title="Attach file (images, PDF, video, documents)"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={`Chiedi a Merlino...`}
                rows={1}
                className="flex-1 resize-none px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent max-h-24"
                style={{ minHeight: '42px' }}
              />
              <button
                onClick={sendMessage}
                disabled={(!input.trim() && pendingFiles.length === 0) || isLoading}
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
