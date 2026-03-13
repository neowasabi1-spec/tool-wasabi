'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { fetchAffiliateSavedFunnels } from '@/lib/supabase-operations';
import type { AffiliateSavedFunnel } from '@/types/database';
import {
  Play,
  Loader2,
  Code2,
  Eye,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  Download,
  Maximize2,
  Minimize2,
  Zap,
  HelpCircle,
  ShoppingCart,
  Heart,
  Utensils,
  Dumbbell,
  Palette,
  Globe,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Layers,
  RefreshCw,
  FileText,
  Camera,
  Package,
  ArrowRight,
  X,
  Image as ImageIcon,
} from 'lucide-react';

interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
}

interface AffiliateFunnelStep {
  step_index: number;
  url: string;
  title: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

interface SwapPayload {
  prompt: string;
  screenshot?: string;
  product?: {
    name: string;
    description: string;
    price: number;
    benefits: string[];
    ctaText: string;
    ctaUrl: string;
    brandName: string;
  };
  funnelSteps?: AffiliateFunnelStep[];
  funnelMeta?: {
    funnel_name?: string;
    brand_name?: string;
    entry_url?: string;
    funnel_type?: string;
    category?: string;
    total_steps?: number;
    analysis_summary?: string;
    persuasion_techniques?: string[];
    notable_elements?: string[];
    lead_capture_method?: string;
  };
  // Chunked mode fields
  mode?: 'simple' | 'swap' | 'chunked';
  designSpec?: unknown;
  cssTokens?: unknown;
  branding?: unknown;
}

type PipelinePhase =
  | 'idle'
  | 'fetching_screenshots'
  | 'analyzing_steps'
  | 'analyzing_design'
  | 'generating_branding'
  | 'generating_css'
  | 'generating_js'
  | 'generating_html'
  | 'assembling'
  | 'done'
  | 'error';

const PHASE_LABELS: Record<PipelinePhase, string> = {
  idle: '',
  fetching_screenshots: 'Retrieving screenshots from database...',
  analyzing_steps: 'Per-step analysis with Gemini Vision...',
  analyzing_design: 'Design analysis with Gemini Vision...',
  generating_branding: 'Generating branding with AI...',
  generating_css: 'Generating CSS Design System...',
  generating_js: 'Generating Quiz Engine JS...',
  generating_html: 'Generating HTML markup...',
  assembling: 'Final server-side assembly...',
  done: 'Completed!',
  error: 'Error',
};

const PRESET_QUIZZES = [
  {
    icon: ShoppingCart,
    label: 'Product Finder',
    color: 'from-blue-500 to-cyan-500',
    prompt:
      'Quiz "Find the perfect product for you" with 5 questions about user preferences (budget, style, usage) and 3 result profiles with product recommendation. Elegant design with blue/purple gradient.',
  },
  {
    icon: Heart,
    label: 'Skincare Routine',
    color: 'from-pink-500 to-rose-500',
    prompt:
      'Quiz "Discover your ideal skincare routine" with 6 questions about skin type, age, concerns. 4 possible results with personalized routine. Feminine design with pink/coral colors and cute icons.',
  },
  {
    icon: Utensils,
    label: 'Ideal Diet',
    color: 'from-green-500 to-emerald-500',
    prompt:
      'Quiz "What\'s the right diet for you?" with 7 questions about goals, allergies, lifestyle. 4 diet result profiles. Fresh design with green colors and food illustrations. Include animated progress bar.',
  },
  {
    icon: Dumbbell,
    label: 'Fitness Plan',
    color: 'from-orange-500 to-amber-500',
    prompt:
      'Quiz "Your personalized fitness plan" with 6 questions about level, goals, available time. 3 result plans (beginner, intermediate, advanced). Energetic design with orange/yellow colors.',
  },
  {
    icon: Palette,
    label: 'Brand Personality',
    color: 'from-purple-500 to-violet-500',
    prompt:
      'Quiz "Discover your brand personality" with 5 questions about values, target, tone of voice. 4 brand archetypes as results. Creative design with purple gradient and modern animations.',
  },
  {
    icon: HelpCircle,
    label: 'Lead Magnet',
    color: 'from-indigo-500 to-blue-600',
    prompt:
      'Quiz lead magnet "How much do you know about digital marketing?" with 8 multiple choice questions, final score with level (novice, intermediate, expert) and call-to-action to download a free guide. Professional design.',
  },
];

export default function SwipeQuizPage() {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [streamProgress, setStreamProgress] = useState(0);
  const [generationPhase, setGenerationPhase] = useState('');

  // Existing funnels from store + Supabase
  const { funnelPages, products, isInitialized } = useStore();
  const [affiliateFunnels, setAffiliateFunnels] = useState<AffiliateSavedFunnel[]>([]);
  const [affiliateLoading, setAffiliateLoading] = useState(false);
  const [showMyFunnels, setShowMyFunnels] = useState(true);
  const [expandedFunnelId, setExpandedFunnelId] = useState<string | null>(null);

  // Swap mode state
  const [selectedFunnel, setSelectedFunnel] = useState<AffiliateSavedFunnel | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [captureScreenshot, setCaptureScreenshot] = useState(true);

  // Pipeline phase tracking for chunked mode
  const [pipelinePhase, setPipelinePhase] = useState<PipelinePhase>('idle');
  const [useChunkedMode, setUseChunkedMode] = useState(true);

  // Multi-Agent mode
  const [useMultiAgentMode, setUseMultiAgentMode] = useState(true);
  const [multiAgentPhase, setMultiAgentPhase] = useState('');
  const [multiAgentConfidence, setMultiAgentConfidence] = useState<number | null>(null);

  // Debug Gemini output
  const [debugGeminiData, setDebugGeminiData] = useState<Record<string, unknown> | null>(null);
  const [debugGeminiLoading, setDebugGeminiLoading] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);

  // Filter quiz-type funnel pages from the store
  const quizFunnelPages = useMemo(
    () => funnelPages.filter((p) => p.pageType === 'quiz_funnel'),
    [funnelPages]
  );

  // Filter affiliate funnels that are quiz-type
  const quizAffiliateFunnels = useMemo(
    () =>
      affiliateFunnels.filter(
        (f) =>
          f.funnel_type?.toLowerCase().includes('quiz') ||
          f.category?.toLowerCase().includes('quiz') ||
          (Array.isArray(f.steps) &&
            (f.steps as unknown as AffiliateFunnelStep[]).some(
              (s) => s.step_type === 'quiz_question' || s.step_type === 'info_screen'
            ))
      ),
    [affiliateFunnels]
  );

  // All affiliate funnels (non-quiz) as fallback
  const otherAffiliateFunnels = useMemo(
    () => affiliateFunnels.filter((f) => !quizAffiliateFunnels.some((q) => q.id === f.id)),
    [affiliateFunnels, quizAffiliateFunnels]
  );

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) || null,
    [products, selectedProductId]
  );

  const loadAffiliateFunnels = useCallback(async () => {
    setAffiliateLoading(true);
    try {
      const data = await fetchAffiliateSavedFunnels();
      setAffiliateFunnels(data);
    } catch (err) {
      console.error('Error loading affiliate funnels:', err);
    } finally {
      setAffiliateLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAffiliateFunnels();
  }, [loadAffiliateFunnels]);

  // Auto-select first product
  useEffect(() => {
    if (products.length > 0 && !selectedProductId) {
      setSelectedProductId(products[0].id);
    }
  }, [products, selectedProductId]);

  const captureQuizScreenshot = async (url: string) => {
    setScreenshotLoading(true);
    setScreenshotBase64(null);
    try {
      const response = await fetch('/api/swipe-quiz/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (data.success && data.screenshot) {
        setScreenshotBase64(data.screenshot);
        return data.screenshot as string;
      } else {
        console.error('Screenshot failed:', data.error);
        return null;
      }
    } catch (err) {
      console.error('Screenshot error:', err);
      return null;
    } finally {
      setScreenshotLoading(false);
    }
  };

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const updateIframe = useCallback((html: string) => {
    if (iframeRef.current) {
      iframeRef.current.srcdoc = html;
    }
  }, []);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight;
    }
  }, [generatedCode]);

  const generateQuiz = async (payload: SwapPayload) => {
    if (!payload.prompt.trim() || isGenerating) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsGenerating(true);
    setGeneratedCode('');
    setUsage(null);
    setError(null);
    setStreamProgress(0);
    setActiveTab('preview');
    setGenerationPhase('Sending to Claude...');

    let accumulated = '';
    // For chunked mode: track CSS and JS chunks separately for progress
    let currentChunk: 'css' | 'js' | 'html' | null = null;

    try {
      const response = await fetch('/api/swipe-quiz/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP Error ${response.status}`);
      }

      setGenerationPhase('Generating quiz code...');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Unable to read stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);

          try {
            const data = JSON.parse(jsonStr);

            if (data.error) {
              setError(data.error);
              setPipelinePhase('error');
              break;
            }

            if (data.done) {
              setUsage(data.usage || null);
              setGenerationPhase('');
              setPipelinePhase('done');
              break;
            }

            // Chunked mode: phase events
            if (data.phase) {
              if (data.phase === 'css') {
                currentChunk = 'css';
                setPipelinePhase('generating_css');
                setGenerationPhase(data.phaseLabel || PHASE_LABELS.generating_css);
                setStreamProgress(30);
              } else if (data.phase === 'css_done') {
                setStreamProgress(45);
              } else if (data.phase === 'js') {
                currentChunk = 'js';
                setPipelinePhase('generating_js');
                setGenerationPhase(data.phaseLabel || PHASE_LABELS.generating_js);
                setStreamProgress(45);
              } else if (data.phase === 'js_done') {
                setStreamProgress(65);
              } else if (data.phase === 'html') {
                currentChunk = 'html';
                setPipelinePhase('generating_html');
                setGenerationPhase(data.phaseLabel || PHASE_LABELS.generating_html);
                setStreamProgress(65);
              } else if (data.phase === 'assembling') {
                setPipelinePhase('assembling');
                setGenerationPhase(data.phaseLabel || PHASE_LABELS.assembling);
                setStreamProgress(90);
              }
              continue;
            }

            // Server-side assembled HTML (new chunked mode: CSS+JS+HTML assembled on server)
            if (data.assembled && data.html) {
              accumulated = data.html;
              setGeneratedCode(accumulated);
              updateIframe(accumulated);
              setStreamProgress(95);
              continue;
            }

            // Chunked mode: chunk text (CSS/JS/HTML markup — intermediate, don't show in preview)
            if (data.chunk && data.text) {
              if (data.chunk === 'css' || data.chunk === 'js') {
                setStreamProgress((prev) => Math.min(prev + 0.3, currentChunk === 'css' ? 44 : 64));
              } else if (data.chunk === 'html_markup') {
                setStreamProgress((prev) => Math.min(prev + 0.3, 89));
              }
              continue;
            }

            // Main text output (legacy mode only — non-chunked)
            if (data.text) {
              accumulated += data.text;
              setGeneratedCode(accumulated);
              setStreamProgress((prev) => Math.min(prev + 0.5, 95));

              if (
                accumulated.includes('</style>') ||
                accumulated.includes('</body>') ||
                accumulated.includes('</html>')
              ) {
                updateIframe(accumulated);
              }
            }
          } catch {
            // skip malformed JSON chunks
          }
        }
      }

      if (accumulated) {
        updateIframe(accumulated);
        setStreamProgress(100);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setError(err instanceof Error ? err.message : 'Error during generation');
      setPipelinePhase('error');
    } finally {
      setIsGenerating(false);
      setGenerationPhase('');
      abortControllerRef.current = null;
    }
  };

  // Simple generation (no swap)
  const generateSimple = (customPrompt?: string) => {
    const finalPrompt = customPrompt || prompt;
    if (!finalPrompt.trim()) return;
    generateQuiz({ prompt: finalPrompt });
  };

  // Full swap generation from a funnel
  const generateSwap = async (funnel: AffiliateSavedFunnel) => {
    const steps = Array.isArray(funnel.steps)
      ? (funnel.steps as unknown as AffiliateFunnelStep[])
      : [];

    const product = selectedProduct
      ? {
          name: selectedProduct.name,
          description: selectedProduct.description,
          price: selectedProduct.price,
          benefits: selectedProduct.benefits,
          ctaText: selectedProduct.ctaText,
          ctaUrl: selectedProduct.ctaUrl,
          brandName: selectedProduct.brandName,
        }
      : undefined;

    const funnelMeta = {
      funnel_name: funnel.funnel_name,
      brand_name: funnel.brand_name || undefined,
      entry_url: funnel.entry_url,
      funnel_type: funnel.funnel_type,
      category: funnel.category,
      total_steps: funnel.total_steps,
      analysis_summary: funnel.analysis_summary || undefined,
      persuasion_techniques: funnel.persuasion_techniques || [],
      notable_elements: funnel.notable_elements || [],
      lead_capture_method: funnel.lead_capture_method || undefined,
    };

    const swapPrompt = product
      ? `Replicate exactly the quiz "${funnel.funnel_name}" but swap all the content for my product "${product.name}" by "${product.brandName}". Keep the same exact structure, number of steps, question types and result logic. Generate branding (colors, tone, copy) suited to my product.`
      : `Replicate exactly the quiz "${funnel.funnel_name}" with the same structure, questions, options and result logic. Create a modern and professional design.`;

    setPrompt(swapPrompt);

    // ── CHUNKED PIPELINE: Per-Step Analysis + Branding + Chunked Generation ──
    if (useChunkedMode && product) {
      setIsGenerating(true);
      setGeneratedCode('');
      setUsage(null);
      setError(null);
      setStreamProgress(0);
      setActiveTab('preview');

      try {
        // Phase 1: Per-step analysis (screenshots + Gemini Vision for each step URL)
        setPipelinePhase('analyzing_steps');
        setGenerationPhase('Starting per-step analysis with Gemini Vision...');
        setStreamProgress(2);

        let designSpec = null;
        let singleScreenshot: string | undefined;
        let cssTokens = null;

        try {
          const analysisRes = await fetch('/api/swipe-quiz/per-step-analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ funnelId: funnel.id }),
          });

          if (analysisRes.ok && analysisRes.body) {
            const reader = analysisRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const data = JSON.parse(line.slice(6));

                  if (data.phase === 'analyzing_step') {
                    setGenerationPhase(
                      `Analyzing step ${data.current}/${data.total}: ${data.stepTitle}...`,
                    );
                    setStreamProgress(2 + Math.round((data.current / data.total) * 15));
                  } else if (data.phase === 'step_done') {
                    setStreamProgress(2 + Math.round((data.current / data.total) * 15));
                  } else if (data.phase === 'complete') {
                    designSpec = data.designSpec || null;
                    if (data.screenshots?.length > 0) {
                      singleScreenshot = data.screenshots[0];
                      setScreenshotBase64(data.screenshots[0]);
                    }
                  }
                } catch {
                  // skip malformed SSE
                }
              }
            }
          }
        } catch (err) {
          console.warn('Per-step analysis failed, continuing with fallback:', err);
        }

        // Fallback: single screenshot if per-step analysis failed
        if (!designSpec && captureScreenshot && funnel.entry_url) {
          setPipelinePhase('analyzing_design');
          setGenerationPhase('Capturing screenshot of original quiz (fallback)...');
          const result = await captureQuizScreenshot(funnel.entry_url);
          if (result) {
            singleScreenshot = result;
            try {
              const designRes = await fetch('/api/swipe-quiz/design-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ screenshots: [result] }),
              });
              const designData = await designRes.json();
              if (designData.success && designData.designSpec) {
                designSpec = designData.designSpec;
              }
            } catch {
              // Design analysis is best-effort
            }
          }
        }

        // CSS tokens from live page
        if (captureScreenshot && funnel.entry_url && !singleScreenshot) {
          try {
            const cssRes = await fetch('/api/swipe-quiz/screenshot', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: funnel.entry_url, extractCss: true }),
            });
            const cssData = await cssRes.json();
            if (cssData.success) {
              cssTokens = cssData.cssTokens || null;
              if (!singleScreenshot && cssData.screenshot) {
                singleScreenshot = cssData.screenshot;
                setScreenshotBase64(cssData.screenshot);
              }
            }
          } catch {
            // CSS extraction is best-effort
          }
        }

        setStreamProgress(20);

        // Phase 2: Generate Branding (using funnelId for direct affiliate_saved_funnels support)
        setPipelinePhase('generating_branding');
        setGenerationPhase(PHASE_LABELS.generating_branding);

        let brandingResult = null;
        try {
          const brandingRes = await fetch('/api/swipe-quiz/generate-branding', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              funnelId: funnel.id,
              product,
              options: { provider: 'gemini', language: 'en' },
            }),
          });
          const brandingData = await brandingRes.json();
          if (brandingData.success && brandingData.branding) {
            brandingResult = brandingData.branding;
          }
        } catch (err) {
          console.warn('Branding generation (funnelId mode) failed:', err);
        }

        // Fallback: try legacy branding if funnelId mode failed
        if (!brandingResult) {
          try {
            const brandingRes = await fetch('/api/swipe-quiz/generate-branding', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entryUrl: funnel.entry_url,
                funnelName: funnel.funnel_name,
                product,
                funnelMeta: {
                  funnel_type: funnel.funnel_type,
                  category: funnel.category,
                  analysis_summary: funnel.analysis_summary,
                  persuasion_techniques: funnel.persuasion_techniques,
                  lead_capture_method: funnel.lead_capture_method,
                  notable_elements: funnel.notable_elements,
                },
                options: { provider: 'gemini', language: 'en' },
              }),
            });
            const brandingData = await brandingRes.json();
            if (brandingData.success && brandingData.branding) {
              brandingResult = brandingData.branding;
            }
          } catch (err) {
            console.warn('Legacy branding also failed:', err);
          }
        }

        setStreamProgress(30);

        // Phase 3: Chunked generation (CSS → JS → HTML markup → server assembly)
        if (brandingResult) {
          setPipelinePhase('generating_css');
          setGenerationPhase(PHASE_LABELS.generating_css);

          await generateQuiz({
            prompt: swapPrompt,
            screenshot: singleScreenshot,
            product,
            funnelSteps: steps,
            funnelMeta,
            mode: 'chunked',
            designSpec,
            cssTokens,
            branding: brandingResult,
          });
        } else {
          // Fallback to legacy swap mode if branding failed
          console.warn('Branding generation failed — falling back to legacy swap mode');
          setPipelinePhase('idle');
          await generateQuiz({
            prompt: swapPrompt,
            screenshot: singleScreenshot,
            product,
            funnelSteps: steps,
            funnelMeta,
            designSpec,
            cssTokens,
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error during pipeline');
        setPipelinePhase('error');
        setIsGenerating(false);
        setGenerationPhase('');
      }
      return;
    }

    // ── LEGACY SWAP MODE (no chunked) ──
    let screenshot: string | undefined;
    if (captureScreenshot && funnel.entry_url) {
      setGenerationPhase('Capturing screenshot of original quiz...');
      const result = await captureQuizScreenshot(funnel.entry_url);
      screenshot = result || undefined;
    }

    await generateQuiz({
      prompt: swapPrompt,
      screenshot,
      product,
      funnelSteps: steps,
      funnelMeta,
    });
  };

  // ── MULTI-AGENT MODE V2: Screenshots → Gemini Analysis → Claude Generation ──
  const generateMultiAgent = async (funnel: AffiliateSavedFunnel) => {
    if (!selectedProduct || isGenerating) return;

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsGenerating(true);
    setGeneratedCode('');
    setUsage(null);
    setError(null);
    setStreamProgress(0);
    setActiveTab('preview');
    setMultiAgentPhase('fetching_screenshots');
    setMultiAgentConfidence(null);
    setGenerationPhase('Retrieving per-step screenshots...');
    setPipelinePhase('idle');

    const steps = Array.isArray(funnel.steps)
      ? (funnel.steps as unknown as AffiliateFunnelStep[])
      : [];

    let accumulated = '';

    try {
      const response = await fetch('/api/swipe-quiz/multiagent-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: funnel.entry_url,
          funnelName: funnel.funnel_name,
          product: {
            name: selectedProduct.name,
            description: selectedProduct.description,
            price: selectedProduct.price,
            benefits: selectedProduct.benefits,
            ctaText: selectedProduct.ctaText,
            ctaUrl: selectedProduct.ctaUrl,
            brandName: selectedProduct.brandName,
          },
          funnelSteps: steps,
          funnelMeta: {
            funnel_type: funnel.funnel_type,
            category: funnel.category,
            analysis_summary: funnel.analysis_summary,
            persuasion_techniques: funnel.persuasion_techniques,
            lead_capture_method: funnel.lead_capture_method,
            notable_elements: funnel.notable_elements,
          },
          extraInstructions: prompt || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || `HTTP Error ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Unable to read stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);

          try {
            const data = JSON.parse(jsonStr);

            if (data.error) {
              setError(data.error);
              break;
            }

            if (data.done) {
              setUsage(data.usage || null);
              setGenerationPhase('');
              setMultiAgentPhase('done');
              break;
            }

            // Phase updates
            if (data.phase) {
              setMultiAgentPhase(data.phase);
              if (data.message) setGenerationPhase(data.message);

              // V2 progress map
              const phaseProgressMap: Record<string, number> = {
                fetching_screenshots: 5,
                screenshots_ready: 15,
                analyzing_visual: 20,
                analyzing_quiz_logic: 25,
                analysis_done: 35,
                generating_branding: 40,
                branding_done: 48,
                generating_html: 50,
                assembling: 95,
              };
              const progress = phaseProgressMap[data.phase];
              if (progress) setStreamProgress(progress);
              continue;
            }

            // HTML text streaming from Claude (unified output)
            if (data.text) {
              accumulated += data.text;
              setGeneratedCode(accumulated);
              setStreamProgress(prev => Math.min(prev + 0.3, 94));

              if (
                accumulated.includes('</style>') ||
                accumulated.includes('</body>') ||
                accumulated.includes('</html>')
              ) {
                updateIframe(accumulated);
              }
            }
          } catch {
            // skip malformed JSON
          }
        }
      }

      if (accumulated) {
        updateIframe(accumulated);
        setStreamProgress(100);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Error during Visual Replication pipeline');
    } finally {
      setIsGenerating(false);
      setGenerationPhase('');
      abortControllerRef.current = null;
    }
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsGenerating(false);
      setGenerationPhase('');
    }
  };

  const copyCode = () => {
    navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadHtml = () => {
    const blob = new Blob([generatedCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'swipe-quiz.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetAll = () => {
    stopGeneration();
    setPrompt('');
    setGeneratedCode('');
    setUsage(null);
    setError(null);
    setStreamProgress(0);
    setSelectedFunnel(null);
    setScreenshotBase64(null);
    setGenerationPhase('');
    setPipelinePhase('idle');
    setMultiAgentPhase('');
    setMultiAgentConfidence(null);
    if (iframeRef.current) {
      iframeRef.current.srcdoc = '';
    }
  };

  // Debug: run only Gemini analysis and show raw output
  const debugGeminiAnalysis = async (funnel: AffiliateSavedFunnel) => {
    setDebugGeminiLoading(true);
    setDebugGeminiData(null);
    setShowDebugModal(true);

    const steps = Array.isArray(funnel.steps)
      ? (funnel.steps as unknown as AffiliateFunnelStep[])
      : [];

    try {
      const res = await fetch('/api/swipe-quiz/debug-gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryUrl: funnel.entry_url,
          funnelName: funnel.funnel_name,
          funnelSteps: steps,
        }),
      });
      const data = await res.json();
      setDebugGeminiData(data);
    } catch (err) {
      setDebugGeminiData({ error: err instanceof Error ? err.message : 'Error' });
    } finally {
      setDebugGeminiLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Swipe Quiz"
        subtitle="Generate interactive quizzes with AI — Swap existing quizzes to your product"
      />

      <div className="p-6">
        {/* Product Selector Bar */}
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl p-4 mb-6 shadow-md">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 text-white">
              <Package className="w-5 h-5" />
              <span className="font-semibold text-sm">My product:</span>
            </div>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="flex-1 min-w-[250px] px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm outline-none focus:bg-white/20 transition-colors [&>option]:text-gray-900"
            >
              <option value="">-- Select product --</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.brandName} (€{p.price})
                </option>
              ))}
            </select>
            {selectedProduct && (
              <div className="flex items-center gap-3 text-white/80 text-xs">
                <span className="bg-white/15 px-2 py-1 rounded">{selectedProduct.brandName}</span>
                <span className="bg-white/15 px-2 py-1 rounded">€{selectedProduct.price}</span>
                <span className="bg-white/15 px-2 py-1 rounded">
                  {selectedProduct.benefits.length} benefits
                </span>
              </div>
            )}
            <div className="flex items-center gap-3 ml-auto">
              <label className="flex items-center gap-2 text-white/80 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={useChunkedMode}
                  onChange={(e) => setUseChunkedMode(e.target.checked)}
                  className="w-3.5 h-3.5 rounded"
                />
                <Zap className="w-3.5 h-3.5" />
                Pipeline HQ
              </label>
              <label className="flex items-center gap-2 text-white/80 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={captureScreenshot}
                  onChange={(e) => setCaptureScreenshot(e.target.checked)}
                  className="w-3.5 h-3.5 rounded"
                />
                <Camera className="w-3.5 h-3.5" />
                Screenshot
              </label>
            </div>
          </div>
          {selectedProduct && (
            <div className="mt-3 text-white/60 text-xs line-clamp-2">
              {selectedProduct.description}
            </div>
          )}
        </div>

        {/* Swap Panel - shown when a funnel is selected */}
        {selectedFunnel && (
          <div className="bg-white rounded-xl shadow-sm border-2 border-indigo-200 p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">Quiz Swap</h3>
                  <p className="text-xs text-gray-500">
                    Replicate structure + branding from your product
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedFunnel(null);
                  setScreenshotBase64(null);
                }}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
              {/* Source funnel */}
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <p className="text-[10px] uppercase font-medium text-gray-400 tracking-wider mb-2">
                  Original Quiz
                </p>
                <p className="font-medium text-gray-800 text-sm mb-1">
                  {selectedFunnel.funnel_name}
                </p>
                {selectedFunnel.brand_name && (
                  <p className="text-xs text-gray-500 mb-1">{selectedFunnel.brand_name}</p>
                )}
                <p className="text-xs text-gray-400 truncate mb-2">{selectedFunnel.entry_url}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">
                    {selectedFunnel.total_steps} step
                  </span>
                  <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded">
                    {selectedFunnel.funnel_type || 'quiz'}
                  </span>
                  {(() => {
                    const steps = Array.isArray(selectedFunnel.steps)
                      ? (selectedFunnel.steps as unknown as AffiliateFunnelStep[])
                      : [];
                    const questions = steps.filter(
                      (s) => s.step_type === 'quiz_question'
                    ).length;
                    return questions > 0 ? (
                      <span className="text-[10px] bg-cyan-50 text-cyan-600 px-1.5 py-0.5 rounded">
                        {questions} questions
                      </span>
                    ) : null;
                  })()}
                </div>

                {/* Screenshot preview */}
                {screenshotBase64 && (
                  <div className="mt-3 relative">
                    <img
                      src={`data:image/png;base64,${screenshotBase64}`}
                      alt="Screenshot quiz"
                      className="w-full max-h-40 object-cover object-top rounded border border-gray-200"
                    />
                    <span className="absolute top-1 right-1 bg-green-500 text-white text-[9px] px-1.5 py-0.5 rounded font-medium">
                      Screenshot OK
                    </span>
                  </div>
                )}
                {screenshotLoading && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Capturing screenshot...
                  </div>
                )}
              </div>

              {/* Arrow */}
              <div className="hidden md:flex flex-col items-center gap-1">
                <ArrowRight className="w-6 h-6 text-indigo-400" />
                <span className="text-[10px] text-indigo-400 font-medium">SWAP</span>
              </div>

              {/* Target product */}
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <p className="text-[10px] uppercase font-medium text-indigo-400 tracking-wider mb-2">
                  Your product
                </p>
                {selectedProduct ? (
                  <>
                    <p className="font-medium text-gray-800 text-sm mb-1">
                      {selectedProduct.name}
                    </p>
                    <p className="text-xs text-gray-500 mb-1">{selectedProduct.brandName}</p>
                    <p className="text-xs text-gray-400 line-clamp-2 mb-2">
                      {selectedProduct.description}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">
                        €{selectedProduct.price}
                      </span>
                      <span className="text-[10px] bg-green-50 text-green-600 px-1.5 py-0.5 rounded">
                        {selectedProduct.benefits.length} benefits
                      </span>
                      <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                        CTA: {selectedProduct.ctaText}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-4">
                    <Package className="w-6 h-6 mx-auto text-indigo-300 mb-1" />
                    <p className="text-xs text-indigo-400">
                      Select a product from the bar above
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Prompt customization */}
            <div className="mt-4">
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Additional instructions (optional)
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="E.g.: Use warmer tones, add a testimonials section before the result, dark green colors..."
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none text-sm"
                disabled={isGenerating}
              />
            </div>

            {/* Mode toggle */}
            <div className="mt-3 flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="swapMode"
                  checked={useMultiAgentMode}
                  onChange={() => setUseMultiAgentMode(true)}
                  className="w-3.5 h-3.5 text-indigo-600"
                />
                <span className="text-xs font-medium text-gray-700 flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-indigo-500" />
                  Visual Replication (Gemini + Claude)
                </span>
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">V2</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="swapMode"
                  checked={!useMultiAgentMode}
                  onChange={() => setUseMultiAgentMode(false)}
                  className="w-3.5 h-3.5 text-gray-400"
                />
                <span className="text-xs text-gray-500">
                  Pipeline Legacy (generate from scratch)
                </span>
              </label>
            </div>

            <button
              onClick={() => useMultiAgentMode ? generateMultiAgent(selectedFunnel) : generateSwap(selectedFunnel)}
              disabled={isGenerating}
              className={`mt-4 w-full flex items-center justify-center gap-2 px-5 py-3 text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold shadow-md ${
                useMultiAgentMode
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700'
                  : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700'
              }`}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {generationPhase || 'Generating...'}
                </>
              ) : useMultiAgentMode ? (
                <>
                  <Layers className="w-4 h-4" />
                  Visual Replication Quiz (Gemini + Claude)
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Swapped Quiz
                  {captureScreenshot && <Camera className="w-4 h-4 ml-1 opacity-60" />}
                  {selectedProduct && <ImageIcon className="w-4 h-4 ml-1 opacity-60" />}
                </>
              )}
            </button>

            {/* Debug Gemini button */}
            <button
              onClick={() => debugGeminiAnalysis(selectedFunnel)}
              disabled={debugGeminiLoading || isGenerating}
              className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-gray-600 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              {debugGeminiLoading ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Gemini analysis in progress...</>
              ) : (
                <><Eye className="w-3.5 h-3.5" /> Debug: View Gemini output (Visual + Quiz Logic)</>
              )}
            </button>
          </div>
        )}

        {/* Debug Gemini Modal */}
        {showDebugModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
                <div className="flex items-center gap-2">
                  <Eye className="w-5 h-5 text-purple-500" />
                  <h3 className="font-semibold text-gray-900">Debug Output Gemini</h3>
                  {debugGeminiData && typeof debugGeminiData.screenshotsCount === 'number' && (
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                      {debugGeminiData.screenshotsCount} screenshots analyzed
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowDebugModal(false)}
                  className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-5">
                {debugGeminiLoading ? (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                    <Loader2 className="w-8 h-8 animate-spin mb-3" />
                    <p className="text-sm">Capturing screenshot + Gemini Vision analysis in progress...</p>
                    <p className="text-xs mt-1 text-gray-300">This may take 1-3 minutes</p>
                  </div>
                ) : debugGeminiData?.error ? (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                    <strong>Error:</strong> {String(debugGeminiData.error)}
                  </div>
                ) : debugGeminiData ? (
                  <div className="space-y-6">
                    {/* Visual Blueprint */}
                    <div>
                      <h4 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                        <Palette className="w-4 h-4 text-indigo-500" />
                        Visual Blueprint (Design System)
                      </h4>
                      <pre className="bg-gray-950 text-green-400 text-xs font-mono p-4 rounded-lg overflow-auto max-h-[400px] leading-relaxed">
                        {JSON.stringify(debugGeminiData.visualBlueprint, null, 2)}
                      </pre>
                    </div>

                    {/* Quiz Logic Blueprint */}
                    <div>
                      <h4 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-emerald-500" />
                        Quiz Logic Blueprint (Content + Scoring)
                      </h4>
                      <pre className="bg-gray-950 text-cyan-400 text-xs font-mono p-4 rounded-lg overflow-auto max-h-[400px] leading-relaxed">
                        {JSON.stringify(debugGeminiData.quizBlueprint, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Prompt + Presets Row (simple mode) */}
        {!selectedFunnel && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-5 h-5 text-purple-500" />
              <h2 className="font-semibold text-gray-900">
                Generate a quiz from scratch
              </h2>
            </div>

            {/* Prompt Input */}
            <div className="flex gap-3 mb-5">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    generateSimple();
                  }
                }}
                placeholder='E.g.: "Quiz to find the perfect beauty product, 5 questions, pink and gold design, with progress bar and personalized results"'
                rows={3}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none resize-none text-sm"
                disabled={isGenerating}
              />
              <div className="flex flex-col gap-2">
                {isGenerating ? (
                  <button
                    onClick={stopGeneration}
                    className="flex items-center gap-2 px-5 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={() => generateSimple()}
                    disabled={!prompt.trim()}
                    className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed text-sm font-medium shadow-sm"
                  >
                    <Play className="w-4 h-4" />
                    Generate
                  </button>
                )}
                <button
                  onClick={resetAll}
                  className="flex items-center gap-2 px-5 py-3 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors text-sm"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
              </div>
            </div>

            {/* Preset Templates */}
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Quick templates
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                {PRESET_QUIZZES.map((preset) => {
                  const Icon = preset.icon;
                  return (
                    <button
                      key={preset.label}
                      onClick={() => {
                        setPrompt(preset.prompt);
                        generateSimple(preset.prompt);
                      }}
                      disabled={isGenerating}
                      className="group flex flex-col items-center gap-2 p-3 rounded-lg border border-gray-200 hover:border-transparent hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div
                        className={`w-10 h-10 rounded-lg bg-gradient-to-br ${preset.color} flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform`}
                      >
                        <Icon className="w-5 h-5 text-white" />
                      </div>
                      <span className="text-xs font-medium text-gray-700 text-center leading-tight">
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* My Quiz Funnels Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-6 overflow-hidden">
          <button
            onClick={() => setShowMyFunnels(!showMyFunnels)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-500" />
              <h2 className="font-semibold text-gray-900">My Quiz Funnels</h2>
              <span className="text-xs bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full font-medium">
                {quizFunnelPages.length + quizAffiliateFunnels.length + otherAffiliateFunnels.length}
              </span>
              {selectedFunnel && (
                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                  Selected: {selectedFunnel.funnel_name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {affiliateLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  loadAffiliateFunnels();
                }}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
                title="Reload funnels"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              {showMyFunnels ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </div>
          </button>

          {showMyFunnels && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-4">
              {/* Quiz Funnel Pages from Store */}
              {quizFunnelPages.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    Front End Funnel Pages (quiz)
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {quizFunnelPages.map((page) => (
                      <button
                        key={page.id}
                        onClick={() => {
                          generateSimple(
                            `Create an interactive quiz inspired by the page "${page.name}". URL: ${page.urlToSwipe}. ${page.prompt || ''} ${
                              page.extractedData
                                ? `Headline: "${page.extractedData.headline}". CTA: ${page.extractedData.cta?.join(', ')}. Benefits: ${page.extractedData.benefits?.join(', ')}`
                                : ''
                            }`
                          );
                        }}
                        disabled={isGenerating}
                        className="group text-left p-4 rounded-lg border border-gray-200 hover:border-indigo-300 hover:shadow-md transition-all disabled:opacity-50"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <span className="text-sm font-medium text-gray-800 line-clamp-1 group-hover:text-indigo-700 transition-colors">
                            {page.name}
                          </span>
                          <Sparkles className="w-4 h-4 text-gray-300 group-hover:text-indigo-500 shrink-0 ml-2 transition-colors" />
                        </div>
                        <p className="text-xs text-gray-400 truncate mb-1.5">{page.urlToSwipe}</p>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              page.swipeStatus === 'completed'
                                ? 'bg-green-100 text-green-700'
                                : page.swipeStatus === 'in_progress'
                                  ? 'bg-yellow-100 text-yellow-700'
                                  : page.swipeStatus === 'failed'
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {page.swipeStatus}
                          </span>
                          {page.extractedData && (
                            <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                              extracted data
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Quiz-type Affiliate Funnels */}
              {quizAffiliateFunnels.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" />
                    Saved Quiz Funnels ({quizAffiliateFunnels.length})
                  </p>
                  <div className="space-y-2">
                    {quizAffiliateFunnels.map((funnel) => {
                      const steps = Array.isArray(funnel.steps)
                        ? (funnel.steps as unknown as AffiliateFunnelStep[])
                        : [];
                      const isExpanded = expandedFunnelId === funnel.id;
                      const isSelected = selectedFunnel?.id === funnel.id;

                      return (
                        <div
                          key={funnel.id}
                          className={`border rounded-lg overflow-hidden transition-colors ${
                            isSelected
                              ? 'border-indigo-400 bg-indigo-50/30 shadow-md'
                              : 'border-gray-200 hover:border-indigo-200'
                          }`}
                        >
                          <div className="flex items-center gap-3 p-3">
                            <div
                              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                                isSelected
                                  ? 'bg-gradient-to-br from-green-500 to-emerald-600'
                                  : 'bg-gradient-to-br from-indigo-500 to-purple-600'
                              }`}
                            >
                              {isSelected ? (
                                <Check className="w-4 h-4 text-white" />
                              ) : (
                                <HelpCircle className="w-4 h-4 text-white" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-800 truncate">
                                  {funnel.funnel_name}
                                </span>
                                {funnel.brand_name && (
                                  <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded shrink-0">
                                    {funnel.brand_name}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-gray-400 truncate">
                                  {funnel.entry_url}
                                </span>
                                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded shrink-0">
                                  {funnel.total_steps} step
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() =>
                                  setExpandedFunnelId(isExpanded ? null : funnel.id)
                                }
                                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
                                title="Show steps"
                              >
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4" />
                                ) : (
                                  <ChevronDown className="w-4 h-4" />
                                )}
                              </button>
                              <a
                                href={funnel.entry_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 text-gray-400 hover:text-blue-600 rounded-md hover:bg-blue-50 transition-colors"
                                onClick={(e) => e.stopPropagation()}
                                title="Open original URL"
                              >
                                <ExternalLink className="w-4 h-4" />
                              </a>
                              <button
                                onClick={() => {
                                  setSelectedFunnel(isSelected ? null : funnel);
                                  setScreenshotBase64(null);
                                }}
                                disabled={isGenerating}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                                  isSelected
                                    ? 'bg-green-600 text-white hover:bg-green-700'
                                    : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700'
                                }`}
                              >
                                {isSelected ? (
                                  <>
                                    <Check className="w-3.5 h-3.5" />
                                    Selected
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-3.5 h-3.5" />
                                    Swap Quiz
                                  </>
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Expanded step details */}
                          {isExpanded && steps.length > 0 && (
                            <div className="border-t border-gray-100 bg-gray-50 p-3">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {steps.map((step, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-start gap-2 p-2 bg-white rounded-md border border-gray-100 text-xs"
                                  >
                                    <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0 text-[10px] font-bold">
                                      {step.step_index}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <p className="font-medium text-gray-700 truncate">
                                        {step.title || 'Untitled'}
                                      </p>
                                      {step.step_type && (
                                        <span
                                          className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                            step.step_type === 'quiz_question'
                                              ? 'bg-indigo-50 text-indigo-600'
                                              : step.step_type === 'lead_capture'
                                                ? 'bg-amber-50 text-amber-600'
                                                : step.step_type === 'info_screen'
                                                  ? 'bg-cyan-50 text-cyan-600'
                                                  : step.step_type === 'result'
                                                    ? 'bg-green-50 text-green-600'
                                                    : 'bg-gray-100 text-gray-500'
                                          }`}
                                        >
                                          {step.step_type}
                                        </span>
                                      )}
                                      {step.options && step.options.length > 0 && (
                                        <p className="text-gray-400 mt-0.5 truncate">
                                          {step.options.join(' · ')}
                                        </p>
                                      )}
                                      {step.description && (
                                        <p className="text-gray-400 mt-0.5 line-clamp-1 italic">
                                          {step.description}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {funnel.persuasion_techniques &&
                                funnel.persuasion_techniques.length > 0 && (
                                  <div className="mt-3 flex flex-wrap gap-1">
                                    {funnel.persuasion_techniques.map((t, i) => (
                                      <span
                                        key={i}
                                        className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded"
                                      >
                                        {t}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              {funnel.analysis_summary && (
                                <p className="mt-2 text-xs text-gray-500 bg-white p-2 rounded border border-gray-100">
                                  {funnel.analysis_summary}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Other Affiliate Funnels */}
              {otherAffiliateFunnels.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" />
                    Other Saved Funnels ({otherAffiliateFunnels.length})
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {otherAffiliateFunnels.slice(0, 9).map((funnel) => (
                      <button
                        key={funnel.id}
                        onClick={() => {
                          setSelectedFunnel(funnel);
                          setScreenshotBase64(null);
                        }}
                        disabled={isGenerating}
                        className={`group text-left p-3 rounded-lg border transition-all disabled:opacity-50 ${
                          selectedFunnel?.id === funnel.id
                            ? 'border-indigo-400 bg-indigo-50'
                            : 'border-gray-200 hover:border-indigo-200 hover:shadow-sm'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-700 truncate group-hover:text-indigo-700 transition-colors">
                            {funnel.funnel_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                            {funnel.funnel_type || funnel.category || 'funnel'}
                          </span>
                          <span className="text-[10px] text-gray-400">
                            {funnel.total_steps} step
                          </span>
                          {funnel.brand_name && (
                            <span className="text-[10px] text-gray-400 truncate">
                              {funnel.brand_name}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  {otherAffiliateFunnels.length > 9 && (
                    <p className="text-xs text-gray-400 mt-2 text-center">
                      +{otherAffiliateFunnels.length - 9} other funnels available
                    </p>
                  )}
                </div>
              )}

              {/* Empty state */}
              {!affiliateLoading &&
                !isInitialized &&
                quizFunnelPages.length === 0 &&
                affiliateFunnels.length === 0 && (
                  <div className="text-center py-8 text-gray-400">
                    <Layers className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    <p className="text-sm">No quiz funnel found</p>
                    <p className="text-xs mt-1">
                      Your funnels from the &quot;Front End Funnel&quot; section and saved funnels
                      will appear here
                    </p>
                  </div>
                )}

              {affiliateLoading && affiliateFunnels.length === 0 && (
                <div className="flex items-center justify-center py-6 gap-2 text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading funnels...</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Pipeline Progress */}
        {isGenerating && (
          <div className="mb-4">
            {/* Multi-Agent V2 phase indicator */}
            {multiAgentPhase && multiAgentPhase !== 'idle' && multiAgentPhase !== 'done' && (
              <div className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1">
                {([
                  { key: 'fetching_screenshots', label: 'Screenshots' },
                  { key: 'analyzing_visual', label: 'Visual AI' },
                  { key: 'analyzing_quiz_logic', label: 'Quiz Logic AI' },
                  { key: 'generating_branding', label: 'Branding' },
                  { key: 'generating_html', label: 'Generate Quiz' },
                ] as const).map((item, idx, arr) => {
                  const phaseOrder = [
                    'fetching_screenshots', 'screenshots_ready',
                    'analyzing_visual', 'analyzing_quiz_logic', 'analysis_done',
                    'generating_branding', 'branding_done',
                    'generating_html', 'assembling',
                  ];
                  const currentPhaseIdx = phaseOrder.indexOf(multiAgentPhase);
                  const itemPhaseIdx = phaseOrder.indexOf(item.key);
                  const isPast = currentPhaseIdx > itemPhaseIdx && itemPhaseIdx >= 0;
                  const isParallel = (item.key === 'analyzing_visual' || item.key === 'analyzing_quiz_logic') &&
                    (multiAgentPhase === 'analyzing_visual' || multiAgentPhase === 'analyzing_quiz_logic');
                  const isCurrent = multiAgentPhase === item.key ||
                    (item.key === 'analyzing_visual' && multiAgentPhase === 'analyzing_quiz_logic') ||
                    (item.key === 'analyzing_quiz_logic' && multiAgentPhase === 'analyzing_visual') ||
                    (item.key === 'generating_html' && multiAgentPhase === 'assembling');

                  return (
                    <div key={item.key} className="flex items-center gap-1.5">
                      <div className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all whitespace-nowrap ${
                        isPast
                          ? 'bg-green-50 text-green-600'
                          : isCurrent || isParallel
                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
                            : 'bg-gray-100 text-gray-400'
                      }`}>
                        {isPast && <Check className="w-3 h-3" />}
                        {(isCurrent || isParallel) && !isPast && <Loader2 className="w-3 h-3 animate-spin" />}
                        {item.label}
                      </div>
                      {idx < arr.length - 1 && <span className="text-gray-300 text-[10px]">&rarr;</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Legacy chunked mode phase indicator */}
            {!multiAgentPhase && pipelinePhase !== 'idle' && (
              <div className="flex items-center gap-1.5 mb-2 overflow-x-auto pb-1">
                {(['fetching_screenshots', 'analyzing_design', 'generating_branding', 'generating_css', 'generating_js', 'generating_html'] as PipelinePhase[]).map((phase, idx) => {
                  const isCurrent = pipelinePhase === phase;
                  const isPast = (['fetching_screenshots', 'analyzing_design', 'generating_branding', 'generating_css', 'generating_js', 'generating_html'] as PipelinePhase[]).indexOf(pipelinePhase) > idx;
                  const labels: Record<string, string> = {
                    fetching_screenshots: 'Screenshots',
                    analyzing_design: 'Design AI',
                    generating_branding: 'Branding',
                    generating_css: 'CSS',
                    generating_js: 'JS Engine',
                    generating_html: 'HTML',
                  };
                  return (
                    <div key={phase} className="flex items-center gap-1.5">
                      <div className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all whitespace-nowrap ${
                        isCurrent
                          ? 'bg-purple-100 text-purple-700 ring-1 ring-purple-300'
                          : isPast
                            ? 'bg-green-50 text-green-600'
                            : 'bg-gray-100 text-gray-400'
                      }`}>
                        {isPast && <Check className="w-3 h-3" />}
                        {isCurrent && <Loader2 className="w-3 h-3 animate-spin" />}
                        {labels[phase]}
                      </div>
                      {idx < 5 && <span className="text-gray-300 text-[10px]">&rarr;</span>}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-3 mb-1">
              <Zap className={`w-4 h-4 animate-pulse ${multiAgentPhase ? 'text-emerald-500' : 'text-purple-500'}`} />
              <span className="text-sm text-gray-600">
                {generationPhase || 'Generating...'}
              </span>
              {multiAgentConfidence !== null && (
                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">
                  Confidence: {Math.round(multiAgentConfidence * 100)}%
                </span>
              )}
              <span className="text-xs text-gray-400 ml-auto">
                {Math.round(streamProgress)}%
              </span>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ease-out ${
                  multiAgentPhase
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
                    : 'bg-gradient-to-r from-purple-500 to-blue-500'
                }`}
                style={{ width: `${streamProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Main Content: Preview + Code */}
        <div
          className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${
            isFullscreen ? 'fixed inset-0 z-50 rounded-none' : ''
          }`}
        >
          {/* Tabs + Actions */}
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-0">
            <div className="flex">
              <button
                onClick={() => setActiveTab('preview')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'preview'
                    ? 'border-purple-500 text-purple-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Eye className="w-4 h-4" />
                Preview Live
              </button>
              <button
                onClick={() => setActiveTab('code')}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'code'
                    ? 'border-purple-500 text-purple-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Code2 className="w-4 h-4" />
                Code
                {generatedCode && (
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                    {(generatedCode.length / 1024).toFixed(1)}KB
                  </span>
                )}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {usage && (
                <span className="text-xs text-gray-400 mr-2">
                  Token: {usage.input_tokens} in / {usage.output_tokens} out
                </span>
              )}
              {generatedCode && (
                <>
                  <button
                    onClick={copyCode}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50 transition-colors text-gray-600"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    onClick={downloadHtml}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-md hover:bg-gray-50 transition-colors text-gray-600"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </>
              )}
              <button
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
              >
                {isFullscreen ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Content Area */}
          <div className={`${isFullscreen ? 'h-[calc(100vh-49px)]' : 'h-[700px]'}`}>
            {/* Preview Tab */}
            <div
              className={`w-full h-full ${activeTab === 'preview' ? 'block' : 'hidden'}`}
            >
              {generatedCode ? (
                <iframe
                  ref={iframeRef}
                  title="Quiz Preview"
                  sandbox="allow-scripts allow-forms"
                  className="w-full h-full border-0"
                  srcDoc={generatedCode}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center mb-4">
                    <Sparkles className="w-10 h-10 text-purple-400" />
                  </div>
                  <p className="text-lg font-medium text-gray-500 mb-1">No quiz generated</p>
                  <p className="text-sm">
                    Write a prompt, choose a template, or select a funnel to swap
                  </p>
                </div>
              )}
            </div>

            {/* Code Tab */}
            <div
              className={`w-full h-full ${activeTab === 'code' ? 'block' : 'hidden'}`}
            >
              {generatedCode ? (
                <pre
                  ref={codeRef}
                  className="w-full h-full overflow-auto p-4 bg-gray-950 text-gray-300 text-xs font-mono leading-relaxed"
                >
                  <code>{generatedCode}</code>
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400">
                  <p className="text-sm">The code will appear here during generation</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Usage Footer */}
        {usage && (
          <div className="mt-4 flex items-center justify-between text-xs text-gray-400">
            <span>
              Generated with Claude Sonnet 4{multiAgentPhase === 'done' ? ' (Visual Replication V2)' : pipelinePhase === 'done' ? ' (Pipeline HQ)' : ''} &middot; {generatedCode.length.toLocaleString()}{' '}
              characters
            </span>
            <span>
              {usage.input_tokens.toLocaleString()} token input &middot;{' '}
              {usage.output_tokens.toLocaleString()} token output
            </span>
          </div>
        )}

        {/* Keyboard shortcut hint */}
        <p className="mt-3 text-xs text-gray-400 text-center">
          Press{' '}
          <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-gray-500 font-mono">
            Cmd+Enter
          </kbd>{' '}
          to generate quickly
        </p>
      </div>
    </div>
  );
}
