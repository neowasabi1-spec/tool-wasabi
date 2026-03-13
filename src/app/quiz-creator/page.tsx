'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import { fetchAffiliateSavedFunnels } from '@/lib/supabase-operations';
import type { AffiliateSavedFunnel } from '@/types/database';
import {
  Globe,
  Loader2,
  Eye,
  Palette,
  Type,
  Layout,
  Sparkles,
  Target,
  Star,
  AlertCircle,
  ExternalLink,
  Copy,
  CheckCircle,
  Image as ImageIcon,
  Layers,
  MousePointer,
  TrendingUp,
  Code,
  Play,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  XCircle,
  Repeat,
  ArrowRight,
  Wand2,
  MessageSquare,
  Zap,
  FolderOpen,
  Search,
  Link,
  Clock,
  Settings2,
  Tag,
  FileStack,
  Lightbulb,
  Filter,
  Calendar,
} from 'lucide-react';

// ─── FUNNEL LABELS & COLORS ──────────────────────────────────────────────────

const FUNNEL_TYPE_LABELS: Record<string, string> = {
  quiz_funnel: 'Quiz Funnel',
  sales_funnel: 'Sales Funnel',
  landing_page: 'Landing Page',
  webinar_funnel: 'Webinar Funnel',
  tripwire_funnel: 'Tripwire Funnel',
  lead_magnet: 'Lead Magnet',
  vsl_funnel: 'VSL Funnel',
  other: 'Other',
};

const CATEGORY_LABELS: Record<string, string> = {
  weight_loss: 'Weight Loss',
  supplements: 'Supplements',
  skincare: 'Skincare',
  fitness: 'Fitness',
  finance: 'Finance',
  saas: 'SaaS',
  ecommerce: 'E-commerce',
  health: 'Health',
  education: 'Education',
  other: 'Other',
};

const FUNNEL_TYPE_COLORS: Record<string, string> = {
  quiz_funnel: 'bg-violet-100 text-violet-800',
  sales_funnel: 'bg-emerald-100 text-emerald-800',
  landing_page: 'bg-sky-100 text-sky-800',
  webinar_funnel: 'bg-rose-100 text-rose-800',
  tripwire_funnel: 'bg-amber-100 text-amber-800',
  lead_magnet: 'bg-teal-100 text-teal-800',
  vsl_funnel: 'bg-orange-100 text-orange-800',
  other: 'bg-slate-100 text-slate-700',
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface BrandIdentity {
  brand_name: string | null;
  logo_description: string | null;
  brand_personality: string;
  target_audience: string;
  industry: string;
}

interface ColorPalette {
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  background_color: string;
  text_color: string;
  all_colors: string[];
  color_scheme_type: string;
  color_mood: string;
}

interface Typography {
  heading_font_style: string;
  body_font_style: string;
  font_weight_pattern: string;
  text_hierarchy: string;
}

interface LayoutStructure {
  layout_type: string;
  sections: string[];
  navigation_style: string;
  hero_section: string | null;
  content_density: string;
  whitespace_usage: string;
}

interface VisualElements {
  images_style: string;
  icons_style: string;
  buttons_style: string;
  cards_style: string;
  decorative_elements: string[];
  animations_detected: string;
}

interface CtaAnalysis {
  primary_cta_text: string;
  primary_cta_style: string;
  secondary_ctas: string[];
  cta_placement: string;
}

interface QuizFunnelElements {
  is_quiz_funnel: boolean;
  quiz_type: string | null;
  question_style: string;
  answer_format: string | null;
  progress_indicator: string;
  steps_detected: number | string | null;
}

interface OverallAssessment {
  design_quality_score: number;
  modernity_score: number;
  conversion_optimization_score: number;
  mobile_readiness_estimate: string;
  key_strengths: string[];
  improvement_suggestions: string[];
  design_style_tags: string[];
}

interface AnalysisResult {
  brand_identity: BrandIdentity;
  color_palette: ColorPalette;
  typography: Typography;
  layout_structure: LayoutStructure;
  visual_elements: VisualElements;
  cta_analysis: CtaAnalysis;
  quiz_funnel_elements: QuizFunnelElements;
  overall_assessment: OverallAssessment;
}

interface ApiResponse {
  success: boolean;
  url: string;
  title: string;
  screenshot: string;
  analysis: AnalysisResult | string;
  analysisRaw?: string;
  error?: string;
  details?: string;
}

interface FunnelStep {
  step_index: number;
  url: string;
  title: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

type GenPhase = 'idle' | 'generate' | 'review' | 'done' | 'error';
type SwipePhase = 'idle' | 'my-branding' | 'swipe-regenerate' | 'done' | 'error';

interface ProductInfo {
  product_name: string;
  product_description: string;
  target_audience: string;
  industry: string;
  tone_of_voice: string;
  unique_selling_points: string;
}

const EMPTY_PRODUCT: ProductInfo = {
  product_name: '',
  product_description: '',
  target_audience: '',
  industry: '',
  tone_of_voice: '',
  unique_selling_points: '',
};

interface GenPhaseStatus {
  phase: GenPhase;
  status: 'pending' | 'running' | 'completed' | 'error';
  duration_ms?: number;
  error?: string;
}

// ─── SMALL COMPONENTS ────────────────────────────────────────────────────────

function ColorSwatch({ color, label }: { color: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(color);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={handleCopy} className="flex flex-col items-center gap-1.5 group cursor-pointer" title={`Copy ${color}`}>
      <div className="w-14 h-14 rounded-xl shadow-md border border-gray-200 group-hover:scale-110 transition-transform relative" style={{ backgroundColor: color }}>
        {copied && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-xl">
            <CheckCircle className="w-5 h-5 text-white" />
          </div>
        )}
      </div>
      <span className="text-xs text-gray-500 font-medium">{label}</span>
      <span className="text-[10px] text-gray-400 font-mono">{color}</span>
    </button>
  );
}

function ScoreBar({ score, label, max = 10 }: { score: number; label: string; max?: number }) {
  const percentage = (score / max) * 100;
  const colorClass = percentage >= 70 ? 'bg-green-500' : percentage >= 40 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-sm text-gray-700">{label}</span>
        <span className="text-sm font-bold text-gray-900">{score}/{max}</span>
      </div>
      <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-1000 ${colorClass}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function SectionCard({ icon: Icon, title, color, children }: { icon: React.ComponentType<{ className?: string }>; title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className={`px-5 py-3 border-b border-gray-100 flex items-center gap-2.5 ${color}`}>
        <Icon className="w-5 h-5" />
        <h3 className="font-semibold text-base">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 py-1.5">
      <span className="text-sm text-gray-500 shrink-0 w-36">{label}</span>
      <span className="text-sm text-gray-900 font-medium">{value}</span>
    </div>
  );
}

function TagList({ tags, colorClass = 'bg-blue-100 text-blue-700' }: { tags: string[]; colorClass?: string }) {
  if (!tags || tags.length === 0) return <span className="text-sm text-gray-400">-</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag, i) => (
        <span key={i} className={`px-2.5 py-1 rounded-full text-xs font-medium ${colorClass}`}>{tag}</span>
      ))}
    </div>
  );
}

// ─── GENERATION PROGRESS ─────────────────────────────────────────────────────

const PHASE_CONFIG = [
  { key: 'generate' as const, label: 'Page Replica', description: 'Pixel-perfect HTML from screenshot', icon: Code },
  { key: 'review' as const, label: 'Review & Fix', description: 'Verify fidelity to screenshot', icon: CheckCircle },
];

function GenerationProgress({ phases, currentPhase }: { phases: GenPhaseStatus[]; currentPhase: GenPhase }) {
  return (
    <div className="flex items-center gap-2 w-full">
      {PHASE_CONFIG.map((cfg, i) => {
        const phaseData = phases.find((p) => p.phase === cfg.key);
        const status = phaseData?.status ?? 'pending';
        const Icon = cfg.icon;

        let dotColor = 'bg-gray-300';
        let textColor = 'text-gray-400';
        let borderColor = 'border-gray-200';
        let bgColor = 'bg-gray-50';

        if (status === 'running') {
          dotColor = 'bg-blue-500 animate-pulse';
          textColor = 'text-blue-700';
          borderColor = 'border-blue-300';
          bgColor = 'bg-blue-50';
        } else if (status === 'completed') {
          dotColor = 'bg-green-500';
          textColor = 'text-green-700';
          borderColor = 'border-green-200';
          bgColor = 'bg-green-50';
        } else if (status === 'error') {
          dotColor = 'bg-red-500';
          textColor = 'text-red-700';
          borderColor = 'border-red-200';
          bgColor = 'bg-red-50';
        }

        return (
          <div key={cfg.key} className="flex items-center flex-1">
            <div className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl border ${borderColor} ${bgColor}`}>
              <div className="relative">
                <div className={`w-8 h-8 rounded-full ${status === 'completed' ? 'bg-green-100' : status === 'running' ? 'bg-blue-100' : 'bg-gray-100'} flex items-center justify-center`}>
                  {status === 'running' ? (
                    <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                  ) : status === 'completed' ? (
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  ) : status === 'error' ? (
                    <XCircle className="w-4 h-4 text-red-600" />
                  ) : (
                    <Icon className="w-4 h-4 text-gray-400" />
                  )}
                </div>
                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${dotColor} border-2 border-white`} />
              </div>
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${textColor}`}>{cfg.label}</p>
                <p className="text-xs text-gray-400 truncate">{cfg.description}</p>
                {phaseData?.duration_ms && (
                  <p className="text-[10px] text-gray-400">{(phaseData.duration_ms / 1000).toFixed(1)}s</p>
                )}
                {phaseData?.error && (
                  <p className="text-[10px] text-red-500 truncate">{phaseData.error}</p>
                )}
              </div>
            </div>
            {i < PHASE_CONFIG.length - 1 && (
              <div className={`w-6 h-0.5 shrink-0 ${status === 'completed' ? 'bg-green-300' : 'bg-gray-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SWIPE PROGRESS ──────────────────────────────────────────────────────────

const SWIPE_PHASE_CONFIG = [
  { key: 'my-branding' as const, label: 'My Branding', description: 'Custom branding generation', icon: Wand2 },
  { key: 'swipe-regenerate' as const, label: 'Swipe & Regenerate', description: 'New swiped analysis', icon: Repeat },
];

function SwipeProgress({ phases, currentPhase }: { phases: GenPhaseStatus[]; currentPhase: SwipePhase }) {
  return (
    <div className="flex items-center gap-3 w-full">
      {SWIPE_PHASE_CONFIG.map((cfg, i) => {
        const phaseData = phases.find((p) => p.phase === cfg.key);
        const status = phaseData?.status ?? 'pending';
        const Icon = cfg.icon;

        let borderColor = 'border-gray-200';
        let bgColor = 'bg-gray-50';
        let textColor = 'text-gray-400';
        let dotColor = 'bg-gray-300';

        if (status === 'running') {
          borderColor = 'border-amber-300'; bgColor = 'bg-amber-50'; textColor = 'text-amber-700'; dotColor = 'bg-amber-500 animate-pulse';
        } else if (status === 'completed') {
          borderColor = 'border-green-200'; bgColor = 'bg-green-50'; textColor = 'text-green-700'; dotColor = 'bg-green-500';
        } else if (status === 'error') {
          borderColor = 'border-red-200'; bgColor = 'bg-red-50'; textColor = 'text-red-700'; dotColor = 'bg-red-500';
        }

        return (
          <div key={cfg.key} className="flex items-center flex-1">
            <div className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl border ${borderColor} ${bgColor}`}>
              <div className="relative">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${status === 'completed' ? 'bg-green-100' : status === 'running' ? 'bg-amber-100' : 'bg-gray-100'}`}>
                  {status === 'running' ? <Loader2 className="w-4 h-4 text-amber-600 animate-spin" /> : status === 'completed' ? <CheckCircle className="w-4 h-4 text-green-600" /> : status === 'error' ? <XCircle className="w-4 h-4 text-red-600" /> : <Icon className="w-4 h-4 text-gray-400" />}
                </div>
                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${dotColor} border-2 border-white`} />
              </div>
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${textColor}`}>{cfg.label}</p>
                <p className="text-xs text-gray-400 truncate">{cfg.description}</p>
                {phaseData?.duration_ms && <p className="text-[10px] text-gray-400">{(phaseData.duration_ms / 1000).toFixed(1)}s</p>}
                {phaseData?.error && <p className="text-[10px] text-red-500 truncate">{phaseData.error}</p>}
              </div>
            </div>
            {i < SWIPE_PHASE_CONFIG.length - 1 && (
              <div className={`mx-1 shrink-0 ${status === 'completed' ? 'text-green-400' : 'text-gray-300'}`}>
                <ArrowRight className="w-5 h-5" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SWIPED ANALYSIS DISPLAY ─────────────────────────────────────────────────

function SwipedAnalysisDisplay({ swiped, original }: { swiped: AnalysisResult; original: AnalysisResult }) {
  const brandSummary = (swiped as unknown as { my_branding_summary?: Record<string, unknown> }).my_branding_summary;

  return (
    <div className="space-y-6">
      {/* Branding Summary (if present) */}
      {brandSummary && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl border border-amber-200 p-5">
          <h4 className="font-bold text-amber-800 mb-3 flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Your Brand - Summary
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {brandSummary.brand_name && <InfoRow label="Brand" value={String(brandSummary.brand_name)} />}
            {brandSummary.value_proposition && <InfoRow label="Value Prop" value={String(brandSummary.value_proposition)} />}
            {brandSummary.quiz_title && <InfoRow label="Quiz Title" value={String(brandSummary.quiz_title)} />}
            {brandSummary.quiz_subtitle && <InfoRow label="Quiz Subtitle" value={String(brandSummary.quiz_subtitle)} />}
            {brandSummary.quiz_hook && <InfoRow label="Quiz Hook" value={String(brandSummary.quiz_hook)} />}
            {brandSummary.cta_primary && <InfoRow label="CTA" value={String(brandSummary.cta_primary)} />}
            {brandSummary.lead_magnet_angle && <InfoRow label="Lead Magnet" value={String(brandSummary.lead_magnet_angle)} />}
            {brandSummary.conversion_strategy && <InfoRow label="Conversion" value={String(brandSummary.conversion_strategy)} />}
          </div>
          {Array.isArray(brandSummary.key_benefits) && brandSummary.key_benefits.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-amber-600 font-medium mb-1.5">Key Benefits</p>
              <TagList tags={brandSummary.key_benefits as string[]} colorClass="bg-amber-100 text-amber-800" />
            </div>
          )}
        </div>
      )}

      {/* Color Comparison */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h4 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Palette className="w-5 h-5 text-pink-500" />
          Color Palette Comparison
        </h4>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Original</p>
            <div className="flex flex-wrap gap-3">
              {original.color_palette?.primary_color && <ColorSwatch color={original.color_palette.primary_color} label="Primary" />}
              {original.color_palette?.secondary_color && <ColorSwatch color={original.color_palette.secondary_color} label="Secondary" />}
              {original.color_palette?.accent_color && <ColorSwatch color={original.color_palette.accent_color} label="Accent" />}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-amber-600 mb-2 uppercase tracking-wider">Swiped (Your Brand)</p>
            <div className="flex flex-wrap gap-3">
              {swiped.color_palette?.primary_color && <ColorSwatch color={swiped.color_palette.primary_color} label="Primary" />}
              {swiped.color_palette?.secondary_color && <ColorSwatch color={swiped.color_palette.secondary_color} label="Secondary" />}
              {swiped.color_palette?.accent_color && <ColorSwatch color={swiped.color_palette.accent_color} label="Accent" />}
            </div>
          </div>
        </div>
        {swiped.color_palette?.all_colors?.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500 mb-2 font-medium">All your brand colors</p>
            <div className="flex gap-1.5 flex-wrap">
              {swiped.color_palette.all_colors.map((c, i) => (
                <div key={i} className="w-9 h-9 rounded-lg border border-gray-200 shadow-sm cursor-pointer hover:scale-125 transition-transform" style={{ backgroundColor: c }} title={c} onClick={() => navigator.clipboard.writeText(c)} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Full swiped analysis cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard icon={Target} title="Brand Identity (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-0.5">
            <InfoRow label="Brand Name" value={swiped.brand_identity?.brand_name} />
            <InfoRow label="Personality" value={swiped.brand_identity?.brand_personality} />
            <InfoRow label="Target Audience" value={swiped.brand_identity?.target_audience} />
            <InfoRow label="Industry" value={swiped.brand_identity?.industry} />
          </div>
        </SectionCard>

        <SectionCard icon={Type} title="Typography (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-0.5">
            <InfoRow label="Heading Font" value={swiped.typography?.heading_font_style} />
            <InfoRow label="Body Font" value={swiped.typography?.body_font_style} />
            <InfoRow label="Weights" value={swiped.typography?.font_weight_pattern} />
            <InfoRow label="Hierarchy" value={swiped.typography?.text_hierarchy} />
          </div>
        </SectionCard>

        <SectionCard icon={MousePointer} title="CTA (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-3">
            <InfoRow label="Primary CTA" value={swiped.cta_analysis?.primary_cta_text} />
            <InfoRow label="CTA Style" value={swiped.cta_analysis?.primary_cta_style} />
            <InfoRow label="Placement" value={swiped.cta_analysis?.cta_placement} />
            {swiped.cta_analysis?.secondary_ctas?.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5 font-medium">Secondary CTAs</p>
                <TagList tags={swiped.cta_analysis.secondary_ctas} colorClass="bg-amber-100 text-amber-700" />
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard icon={Sparkles} title="Quiz Funnel (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-0.5">
            <InfoRow label="Quiz Type" value={swiped.quiz_funnel_elements?.quiz_type} />
            <InfoRow label="Question Style" value={swiped.quiz_funnel_elements?.question_style} />
            <InfoRow label="Answer Format" value={swiped.quiz_funnel_elements?.answer_format} />
            <InfoRow label="Progress" value={swiped.quiz_funnel_elements?.progress_indicator} />
            <InfoRow label="Step" value={swiped.quiz_funnel_elements?.steps_detected != null ? String(swiped.quiz_funnel_elements.steps_detected) : null} />
          </div>
        </SectionCard>

        <SectionCard icon={Layout} title="Layout (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-3">
            <InfoRow label="Layout Type" value={swiped.layout_structure?.layout_type} />
            <InfoRow label="Hero Section" value={swiped.layout_structure?.hero_section} />
            <InfoRow label="Density" value={swiped.layout_structure?.content_density} />
            {swiped.layout_structure?.sections?.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5 font-medium">Sections</p>
                <TagList tags={swiped.layout_structure.sections} colorClass="bg-amber-100 text-amber-700" />
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard icon={TrendingUp} title="Assessment (Swiped)" color="bg-amber-50 text-amber-700">
          <div className="space-y-4">
            <div className="space-y-3">
              <ScoreBar score={swiped.overall_assessment?.design_quality_score ?? 0} label="Design Quality" />
              <ScoreBar score={swiped.overall_assessment?.modernity_score ?? 0} label="Modernity" />
              <ScoreBar score={swiped.overall_assessment?.conversion_optimization_score ?? 0} label="Conversions" />
            </div>
            {swiped.overall_assessment?.key_strengths?.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5 font-medium">Key Strengths</p>
                <ul className="space-y-1">
                  {swiped.overall_assessment.key_strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700"><Star className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {swiped.overall_assessment?.design_style_tags?.length > 0 && (
              <TagList tags={swiped.overall_assessment.design_style_tags} colorClass="bg-amber-100 text-amber-700" />
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

// ─── MAIN PAGE ───────────────────────────────────────────────────────────────

export default function QuizCreatorPage() {
  const searchParams = useSearchParams();
  const [url, setUrl] = useState('');
  const [screenshotDelay, setScreenshotDelay] = useState<number>(0);

  // Auto-fill URL from query params (e.g. from My Funnels "Swipe" button)
  useEffect(() => {
    const urlParam = searchParams.get('url');
    if (urlParam) setUrl(urlParam);
  }, [searchParams]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');

  // Code generation state
  const [genPhases, setGenPhases] = useState<GenPhaseStatus[]>([]);
  const [currentGenPhase, setCurrentGenPhase] = useState<GenPhase>('idle');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [finalCode, setFinalCode] = useState<string | null>(null);
  const [codeViewTab, setCodeViewTab] = useState<'preview' | 'code'>('preview');
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [genSource, setGenSource] = useState<'original' | 'swiped'>('original');

  // Swipe analysis state
  const [productInfo, setProductInfo] = useState<ProductInfo>(EMPTY_PRODUCT);
  const [swipePhases, setSwipePhases] = useState<GenPhaseStatus[]>([]);
  const [currentSwipePhase, setCurrentSwipePhase] = useState<SwipePhase>('idle');
  const [myBranding, setMyBranding] = useState<Record<string, unknown> | null>(null);
  const [swipedAnalysis, setSwipedAnalysis] = useState<AnalysisResult | null>(null);
  const [swipedAnalysisRaw, setSwipedAnalysisRaw] = useState<Record<string, unknown> | null>(null);
  const [swipeViewTab, setSwipeViewTab] = useState<'visual' | 'branding-json' | 'swiped-json'>('visual');

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Saved funnels state
  const [savedFunnels, setSavedFunnels] = useState<AffiliateSavedFunnel[]>([]);
  const [funnelsLoading, setFunnelsLoading] = useState(true);
  const [funnelsExpanded, setFunnelsExpanded] = useState(true);
  const [expandedFunnelId, setExpandedFunnelId] = useState<string | null>(null);
  const [funnelSearch, setFunnelSearch] = useState('');
  const [funnelFilterType, setFunnelFilterType] = useState<string>('all');
  const [funnelFilterCategory, setFunnelFilterCategory] = useState<string>('all');

  // Load saved funnels on mount
  useEffect(() => {
    const loadFunnels = async () => {
      setFunnelsLoading(true);
      try {
        const data = await fetchAffiliateSavedFunnels();
        setSavedFunnels(data);
      } catch (err) {
        console.error('Error loading saved funnels:', err);
      } finally {
        setFunnelsLoading(false);
      }
    };
    loadFunnels();
  }, []);

  // Unique types & categories for filters
  const funnelUniqueTypes = useMemo(() => {
    const set = new Set(savedFunnels.map((f) => f.funnel_type));
    return Array.from(set).sort();
  }, [savedFunnels]);

  const funnelUniqueCategories = useMemo(() => {
    const set = new Set(savedFunnels.map((f) => f.category));
    return Array.from(set).sort();
  }, [savedFunnels]);

  // Filter funnels by search + type + category
  const filteredFunnels = useMemo(() => {
    return savedFunnels.filter((f) => {
      if (funnelFilterType !== 'all' && f.funnel_type !== funnelFilterType) return false;
      if (funnelFilterCategory !== 'all' && f.category !== funnelFilterCategory) return false;
      if (funnelSearch.trim()) {
        const q = funnelSearch.toLowerCase();
        const matchName = f.funnel_name?.toLowerCase().includes(q);
        const matchBrand = f.brand_name?.toLowerCase().includes(q);
        const matchUrl = f.entry_url?.toLowerCase().includes(q);
        const matchCategory = f.category?.toLowerCase().includes(q);
        const matchType = f.funnel_type?.toLowerCase().includes(q);
        const matchTags = f.tags?.some((t) => t.toLowerCase().includes(q));
        if (!matchName && !matchBrand && !matchUrl && !matchCategory && !matchType && !matchTags) return false;
      }
      return true;
    });
  }, [savedFunnels, funnelSearch, funnelFilterType, funnelFilterCategory]);

  // Select a step URL -> auto-fill the analysis input
  const selectStepUrl = (stepUrl: string) => {
    setUrl(stepUrl);
    setFunnelsExpanded(false);
  };

  // ─── ANALYSIS ──────────────────────────────────────────

  const runAnalysis = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setResult(null);
    setError(null);
    setGeneratedCode(null);
    setFinalCode(null);
    setGenPhases([]);
    setCurrentGenPhase('idle');

    try {
      const res = await fetch('/api/quiz-creator/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          ...(screenshotDelay > 0 && { screenshotDelay }),
        }),
      });
      const data = (await res.json()) as ApiResponse;
      if (!res.ok || !data.success) {
        setError(data.error || `HTTP Error ${res.status}`);
        if (data.screenshot) setResult(data);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const analysis = result?.analysis && typeof result.analysis === 'object' ? (result.analysis as AnalysisResult) : null;

  // ─── CODE GENERATION (3-phase) ─────────────────────────

  const updatePhase = useCallback((phase: GenPhase, status: GenPhaseStatus['status'], extra?: Partial<GenPhaseStatus>) => {
    setGenPhases((prev) => {
      const existing = prev.findIndex((p) => p.phase === phase);
      const updated: GenPhaseStatus = { phase, status, ...extra };
      if (existing >= 0) {
        const copy = [...prev];
        copy[existing] = { ...copy[existing], ...updated };
        return copy;
      }
      return [...prev, updated];
    });
  }, []);

  const runCodeGeneration = async (useSwipedAnalysis = false) => {
    if (!result || !analysis) return;
    if (useSwipedAnalysis && !swipedAnalysis) return;

    setGeneratedCode(null);
    setFinalCode(null);
    setCodeCopied(false);
    setGenSource(useSwipedAnalysis ? 'swiped' : 'original');
    setGenPhases([
      { phase: 'generate', status: 'pending' },
      { phase: 'review', status: 'pending' },
    ]);
    setCurrentGenPhase('generate');
    setAnalysisCollapsed(true);
    setCodeViewTab('preview');

    const basePayload: Record<string, unknown> = {
      screenshot: result.screenshot,
      url: result.url,
      title: result.title,
    };

    if (useSwipedAnalysis) {
      basePayload.swipeMode = true;
      basePayload.swipedAnalysis = swipedAnalysis;
      basePayload.originalAnalysis = result.analysis;
    } else {
      basePayload.analysis = result.analysis;
    }

    try {
      // ── Phase 1: Generate ──
      updatePhase('generate', 'running');
      setCurrentGenPhase('generate');

      const genRes = await fetch('/api/quiz-creator/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basePayload, phase: 'generate' }),
      });
      const genData = await genRes.json();

      if (!genRes.ok || !genData.success || !genData.code) {
        updatePhase('generate', 'error', { error: genData.error || 'Generation failed', duration_ms: genData.duration_ms });
        setCurrentGenPhase('error');
        return;
      }

      setGeneratedCode(genData.code);
      updatePhase('generate', 'completed', { duration_ms: genData.duration_ms });

      // ── Phase 2: Review ──
      updatePhase('review', 'running');
      setCurrentGenPhase('review');

      const revRes = await fetch('/api/quiz-creator/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basePayload, phase: 'review', generatedCode: genData.code }),
      });
      const revData = await revRes.json();

      if (!revRes.ok || !revData.success || !revData.code) {
        setFinalCode(genData.code);
        updatePhase('review', 'error', { error: revData.error || 'Review failed (using pre-review code)', duration_ms: revData.duration_ms });
        setCurrentGenPhase('done');
        return;
      }

      setFinalCode(revData.code);
      updatePhase('review', 'completed', { duration_ms: revData.duration_ms });
      setCurrentGenPhase('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      updatePhase(currentGenPhase === 'idle' ? 'generate' : currentGenPhase as 'generate' | 'review', 'error', { error: msg });
      setCurrentGenPhase('error');
    }
  };

  const displayCode = finalCode || generatedCode;

  const copyCode = () => {
    if (displayCode) {
      navigator.clipboard.writeText(displayCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  const downloadCode = () => {
    if (!displayCode) return;
    const blob = new Blob([displayCode], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `replica-${result?.title?.replace(/\s+/g, '-').toLowerCase() || 'generated'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyFullJson = () => {
    if (result?.analysis) {
      navigator.clipboard.writeText(JSON.stringify(result.analysis, null, 2));
    }
  };

  const isGenerating = currentGenPhase !== 'idle' && currentGenPhase !== 'done' && currentGenPhase !== 'error';
  const isSwiping = currentSwipePhase !== 'idle' && currentSwipePhase !== 'done' && currentSwipePhase !== 'error';

  const updateSwipePhase = useCallback((phase: SwipePhase, status: GenPhaseStatus['status'], extra?: Partial<GenPhaseStatus>) => {
    setSwipePhases((prev) => {
      const existing = prev.findIndex((p) => p.phase === phase);
      const updated: GenPhaseStatus = { phase, status, ...extra };
      if (existing >= 0) {
        const copy = [...prev];
        copy[existing] = { ...copy[existing], ...updated };
        return copy;
      }
      return [...prev, updated];
    });
  }, []);

  const updateProductField = (field: keyof ProductInfo, value: string) => {
    setProductInfo((prev) => ({ ...prev, [field]: value }));
  };

  const isProductInfoValid = productInfo.product_name.trim() && productInfo.product_description.trim();

  const runSwipeAnalysis = async () => {
    if (!result || !analysis || !isProductInfoValid) return;

    setMyBranding(null);
    setSwipedAnalysis(null);
    setSwipedAnalysisRaw(null);
    setSwipePhases([
      { phase: 'my-branding', status: 'pending' },
      { phase: 'swipe-regenerate', status: 'pending' },
    ]);
    setCurrentSwipePhase('my-branding');
    setSwipeViewTab('visual');

    try {
      // ── Phase 1: My Branding ──
      updateSwipePhase('my-branding', 'running');

      const bpRes = await fetch('/api/quiz-creator/swipe-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'my-branding',
          screenshot: result.screenshot,
          originalAnalysis: result.analysis,
          productInfo,
        }),
      });
      const bpData = await bpRes.json();

      if (!bpRes.ok || !bpData.success || !bpData.myBranding) {
        updateSwipePhase('my-branding', 'error', { error: bpData.error || 'Branding generation failed', duration_ms: bpData.duration_ms });
        setCurrentSwipePhase('error');
        return;
      }

      setMyBranding(bpData.myBranding);
      updateSwipePhase('my-branding', 'completed', { duration_ms: bpData.duration_ms });

      // ── Phase 2: Swipe Regenerate ──
      updateSwipePhase('swipe-regenerate', 'running');
      setCurrentSwipePhase('swipe-regenerate');

      const swRes = await fetch('/api/quiz-creator/swipe-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'swipe-regenerate',
          screenshot: result.screenshot,
          originalAnalysis: result.analysis,
          myBranding: bpData.myBranding,
        }),
      });
      const swData = await swRes.json();

      if (!swRes.ok || !swData.success || !swData.swipedAnalysis) {
        updateSwipePhase('swipe-regenerate', 'error', { error: swData.error || 'Swipe failed', duration_ms: swData.duration_ms });
        setCurrentSwipePhase('error');
        return;
      }

      setSwipedAnalysis(swData.swipedAnalysis as AnalysisResult);
      setSwipedAnalysisRaw(swData.swipedAnalysis);
      updateSwipePhase('swipe-regenerate', 'completed', { duration_ms: swData.duration_ms });
      setCurrentSwipePhase('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      updateSwipePhase(currentSwipePhase === 'idle' ? 'my-branding' : currentSwipePhase as 'my-branding' | 'swipe-regenerate', 'error', { error: msg });
      setCurrentSwipePhase('error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="Quiz Creator" subtitle="Gemini Analysis + pixel-perfect HTML page replica" />

      <div className="p-6 max-w-7xl mx-auto">
        {/* URL Input Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Globe className="w-5 h-5 text-indigo-500" />
            Enter URL to Analyze
          </h3>
          <div className="flex gap-3">
            <div className="flex-1">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !loading && !isGenerating && !isSwiping) runAnalysis(); }}
                placeholder="https://example.com/quiz-funnel"
                className="w-full px-4 py-3.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-lg"
                disabled={loading || isGenerating || isSwiping}
              />
            </div>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" className="px-4 py-3.5 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 transition-colors flex items-center">
                <ExternalLink className="w-5 h-5" />
              </a>
            )}
            <button
              onClick={runAnalysis}
              disabled={!url.trim() || loading || isGenerating || isSwiping}
              className="flex items-center gap-2.5 px-6 py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed font-medium shadow-lg shadow-indigo-200 disabled:shadow-none"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Eye className="w-5 h-5" />}
              <span>{loading ? 'Analyzing...' : 'Analyze'}</span>
            </button>
          </div>
          <div className="flex items-center justify-between mt-3">
            <p className="text-xs text-gray-400">
              Gemini Vision AI analyzes the screenshot, then Claude generates identical HTML of the page.
            </p>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 transition-colors"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Options</span>
              {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>

          {/* Advanced Options */}
          {showAdvanced && (
            <div className="mt-4 p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Settings2 className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-semibold text-gray-700">Screenshot Options</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2.5">
                  <Clock className="w-4 h-4 text-indigo-500" />
                  <label className="text-sm text-gray-700 font-medium">Delay Screenshot</label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={120}
                    step={1}
                    value={screenshotDelay}
                    onChange={(e) => setScreenshotDelay(Math.max(0, Math.min(120, Number(e.target.value) || 0)))}
                    className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    disabled={loading || isGenerating || isSwiping}
                  />
                  <span className="text-sm text-gray-500">seconds</span>
                </div>
              </div>
              <p className="text-xs text-gray-400 ml-6">
                {screenshotDelay > 0
                  ? `The screenshot will be taken ${screenshotDelay} seconds after page load. Useful for quizzes/funnels with animations or dynamic loading.`
                  : 'Default: ~5.5 seconds (4s render wait + networkidle + 1.5s). Set a value > 0 for a custom delay.'}
              </p>
            </div>
          )}
        </div>

        {/* ═══ SELEZIONA TEMPLATE (ALL MY FUNNELS) ═══ */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-6">
          <button
            onClick={() => setFunnelsExpanded(!funnelsExpanded)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <FolderOpen className="w-5 h-5 text-indigo-500" />
              <h3 className="font-semibold text-gray-900">Select Template</h3>
              <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-bold rounded-full">
                {savedFunnels.length}
              </span>
              {filteredFunnels.length !== savedFunnels.length && (
                <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-full">
                  {filteredFunnels.length} filtered
                </span>
              )}
            </div>
            {funnelsExpanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
          </button>

          {funnelsExpanded && (
            <div className="border-t border-gray-100">
              {/* Search + Filters */}
              <div className="px-6 py-3 bg-gray-50 border-b border-gray-100 space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={funnelSearch}
                    onChange={(e) => setFunnelSearch(e.target.value)}
                    placeholder="Search by name, brand, URL, tag..."
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-400" />
                  <select
                    value={funnelFilterType}
                    onChange={(e) => setFunnelFilterType(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 outline-none"
                  >
                    <option value="all">All types</option>
                    {funnelUniqueTypes.map((t) => (
                      <option key={t} value={t}>
                        {FUNNEL_TYPE_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>
                  <select
                    value={funnelFilterCategory}
                    onChange={(e) => setFunnelFilterCategory(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 outline-none"
                  >
                    <option value="all">All categories</option>
                    {funnelUniqueCategories.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c] ?? c}
                      </option>
                    ))}
                  </select>
                  {(funnelFilterType !== 'all' || funnelFilterCategory !== 'all' || funnelSearch) && (
                    <button
                      onClick={() => {
                        setFunnelFilterType('all');
                        setFunnelFilterCategory('all');
                        setFunnelSearch('');
                      }}
                      className="text-xs text-gray-500 hover:text-indigo-600 underline ml-1"
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              </div>

              {/* Funnels List */}
              <div className="max-h-[520px] overflow-y-auto">
                {funnelsLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
                    <span className="ml-2 text-gray-500 text-sm">Loading saved templates...</span>
                  </div>
                ) : filteredFunnels.length === 0 ? (
                  <div className="py-10 text-center text-gray-400 text-sm">
                    {funnelSearch || funnelFilterType !== 'all' || funnelFilterCategory !== 'all'
                      ? 'No results found. Try adjusting the filters.'
                      : 'No saved funnels. Use the Affiliate Browser Chat to analyze and save funnels.'}
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {filteredFunnels.map((funnel) => {
                      const steps = Array.isArray(funnel.steps) ? (funnel.steps as unknown as FunnelStep[]) : [];
                      const isExpanded = expandedFunnelId === funnel.id;
                      const typeColor = FUNNEL_TYPE_COLORS[funnel.funnel_type] ?? FUNNEL_TYPE_COLORS.other;

                      return (
                        <div key={funnel.id} className="group">
                          {/* Funnel Header */}
                          <div
                            className="flex items-start gap-3 px-6 py-3.5 hover:bg-indigo-50/50 cursor-pointer transition-colors"
                            onClick={() => setExpandedFunnelId(isExpanded ? null : funnel.id)}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-medium text-gray-900 text-sm truncate">{funnel.funnel_name}</p>
                                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${typeColor}`}>
                                  {FUNNEL_TYPE_LABELS[funnel.funnel_type] ?? funnel.funnel_type}
                                </span>
                                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                                  {CATEGORY_LABELS[funnel.category] ?? funnel.category}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 mt-1">
                                {funnel.brand_name && (
                                  <span className="text-xs text-gray-500">{funnel.brand_name}</span>
                                )}
                                <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                                  <FileStack className="w-3 h-3" />
                                  {funnel.total_steps ?? steps.length} step
                                </span>
                                <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                                  <Calendar className="w-3 h-3" />
                                  {formatDate(funnel.created_at)}
                                </span>
                              </div>
                              {/* Tags */}
                              {funnel.tags && funnel.tags.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {funnel.tags.slice(0, 4).map((tag, i) => (
                                    <span
                                      key={i}
                                      className="inline-flex items-center gap-0.5 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700 border border-indigo-200/60"
                                    >
                                      <Tag className="h-2.5 w-2.5" />
                                      {tag}
                                    </span>
                                  ))}
                                  {funnel.tags.length > 4 && (
                                    <span className="text-[10px] text-gray-400">+{funnel.tags.length - 4}</span>
                                  )}
                                </div>
                              )}
                              {/* Persuasion techniques */}
                              {funnel.persuasion_techniques && funnel.persuasion_techniques.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {funnel.persuasion_techniques.slice(0, 3).map((tech, i) => (
                                    <span
                                      key={i}
                                      className="inline-flex items-center gap-0.5 rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700 border border-violet-200/60"
                                    >
                                      <Lightbulb className="h-2.5 w-2.5" />
                                      {tech}
                                    </span>
                                  ))}
                                  {funnel.persuasion_techniques.length > 3 && (
                                    <span className="text-[10px] text-gray-400">
                                      +{funnel.persuasion_techniques.length - 3}
                                    </span>
                                  )}
                                </div>
                              )}
                              {/* Analysis summary */}
                              {funnel.analysis_summary && (
                                <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed line-clamp-2">
                                  <Sparkles className="h-3 w-3 inline mr-0.5 text-indigo-400" />
                                  {funnel.analysis_summary}
                                </p>
                              )}
                            </div>

                            {/* Quick-select entry URL */}
                            <button
                              onClick={(e) => { e.stopPropagation(); selectStepUrl(funnel.entry_url); }}
                              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-200 transition-colors opacity-0 group-hover:opacity-100"
                              title={funnel.entry_url}
                            >
                              <Link className="w-3 h-3" />
                              Use Entry URL
                            </button>

                            <div className={`shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                              <ChevronDown className="w-4 h-4 text-gray-400" />
                            </div>
                          </div>

                          {/* Expanded Steps */}
                          {isExpanded && steps.length > 0 && (
                            <div className="bg-gray-50/70 border-t border-gray-100">
                              <div className="px-6 py-2">
                                <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400 mb-2">
                                  Select a step to analyze
                                </p>
                              </div>
                              <div className="divide-y divide-gray-100">
                                {steps.map((step, idx) => (
                                  <button
                                    key={idx}
                                    onClick={() => selectStepUrl(step.url)}
                                    className="w-full flex items-center gap-3 px-6 py-2.5 text-left hover:bg-indigo-50 transition-colors group/step"
                                  >
                                    <div className="w-7 h-7 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0 group-hover/step:bg-indigo-100 group-hover/step:text-indigo-600 group-hover/step:border-indigo-200 transition-colors">
                                      {step.step_index + 1}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm text-gray-800 truncate">
                                        {step.title || `Step ${step.step_index + 1}`}
                                      </p>
                                      <p className="text-[11px] text-gray-400 truncate font-mono">{step.url}</p>
                                    </div>
                                    {step.step_type && (
                                      <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-medium ${
                                        step.step_type === 'quiz_question' ? 'bg-purple-100 text-purple-600' :
                                        step.step_type === 'info_screen' ? 'bg-blue-100 text-blue-600' :
                                        step.step_type === 'results' ? 'bg-green-100 text-green-600' :
                                        step.step_type === 'lead_capture' ? 'bg-amber-100 text-amber-600' :
                                        step.step_type === 'checkout' ? 'bg-emerald-100 text-emerald-600' :
                                        step.step_type === 'upsell' ? 'bg-orange-100 text-orange-600' :
                                        step.step_type === 'thank_you' ? 'bg-green-100 text-green-600' :
                                        step.step_type === 'landing' ? 'bg-blue-100 text-blue-600' :
                                        'bg-gray-100 text-gray-500'
                                      }`}>
                                        {step.step_type.replace(/_/g, ' ')}
                                      </span>
                                    )}
                                    <ArrowRight className="w-4 h-4 text-gray-300 shrink-0 group-hover/step:text-indigo-500 transition-colors" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Expanded but no steps - show entry URL */}
                          {isExpanded && steps.length === 0 && (
                            <div className="bg-gray-50/70 border-t border-gray-100 px-6 py-4">
                              <p className="text-sm text-gray-500 mb-2">No saved steps. Use the entry URL:</p>
                              <button
                                onClick={() => selectStepUrl(funnel.entry_url)}
                                className="flex items-center gap-2 px-4 py-2 bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-200 transition-colors"
                              >
                                <Link className="w-4 h-4" />
                                <span className="truncate">{funnel.entry_url}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Loading State (Analysis) */}
        {loading && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white rounded-2xl p-10 shadow-2xl flex flex-col items-center max-w-sm">
              <div className="relative mb-6">
                <div className="w-20 h-20 rounded-full bg-indigo-100 flex items-center justify-center">
                  <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-purple-600" />
                </div>
              </div>
              <p className="text-gray-900 font-semibold text-lg">Analysis in progress...</p>
              <div className="mt-3 space-y-1.5 text-center">
                <p className="text-gray-500 text-sm">1. Page screenshot</p>
                <p className="text-gray-500 text-sm">2. Gemini Vision AI analysis</p>
                <p className="text-gray-500 text-sm">3. Branding and color extraction</p>
              </div>
              <p className="text-gray-400 text-xs mt-4">This process may take 15-30 seconds</p>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !result && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 text-red-500 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-semibold text-red-800">Error</h4>
                <p className="text-red-700 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Screenshot + Generate Button Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Screenshot */}
              <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <ImageIcon className="w-5 h-5 text-gray-500" />
                    <h3 className="font-semibold text-gray-900 truncate">{result.title || 'Screenshot'}</h3>
                  </div>
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1 shrink-0">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="p-3 bg-gray-50">
                  <div className="max-h-[350px] overflow-y-auto rounded-lg border border-gray-200 shadow-inner">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`data:image/png;base64,${result.screenshot}`} alt="Page screenshot" className="w-full" />
                  </div>
                </div>
              </div>

              {/* Generate Code Card */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl shadow-lg border border-gray-700 overflow-hidden flex flex-col">
                <div className="px-5 py-4 border-b border-gray-700">
                  <h3 className="font-bold text-white text-lg flex items-center gap-2">
                    <Code className="w-5 h-5 text-emerald-400" />
                    Page Replica
                  </h3>
                  <p className="text-gray-400 text-xs mt-1">
                    Claude AI generates pixel-perfect HTML based on the screenshot and Gemini analysis. This page only, no new quiz.
                  </p>
                </div>

                <div className="flex-1 p-5 flex flex-col justify-between">
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-2 text-gray-300">
                      <div className="w-6 h-6 rounded-full bg-emerald-900/50 flex items-center justify-center text-xs text-emerald-400 font-bold">1</div>
                      <span>Gemini Analysis = Visual blueprint</span>
                    </div>
                    <div className="flex items-center gap-2 text-gray-300">
                      <div className="w-6 h-6 rounded-full bg-emerald-900/50 flex items-center justify-center text-xs text-emerald-400 font-bold">2</div>
                      <span>Claude replicates in HTML/CSS/JS</span>
                    </div>
                    <div className="flex items-center gap-2 text-gray-300">
                      <div className="w-6 h-6 rounded-full bg-emerald-900/50 flex items-center justify-center text-xs text-emerald-400 font-bold">3</div>
                      <span>Review: comparison with screenshot</span>
                    </div>
                  </div>

                  <button
                    onClick={() => runCodeGeneration(false)}
                    disabled={!analysis || isGenerating || isSwiping}
                    className="mt-5 w-full flex items-center justify-center gap-2.5 px-6 py-4 bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-xl hover:from-emerald-600 hover:to-teal-600 transition-all disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed font-bold text-base shadow-lg shadow-emerald-900/30 disabled:shadow-none"
                  >
                    {isGenerating && genSource === 'original' ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : currentGenPhase === 'done' && genSource === 'original' ? (
                      <RefreshCw className="w-5 h-5" />
                    ) : (
                      <Play className="w-5 h-5" />
                    )}
                    <span>
                      {isGenerating && genSource === 'original'
                        ? 'Replicating...'
                        : currentGenPhase === 'done' && genSource === 'original'
                          ? 'Regenerate Replica'
                          : 'Generate HTML Replica'}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Error from API (partial) */}
            {error && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                  <p className="text-yellow-800 text-sm">{error}</p>
                </div>
              </div>
            )}

            {/* Generation Progress */}
            {genPhases.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-500" />
                  {genSource === 'swiped' ? 'Swiped Replica' : 'Page Replica'} - Progress
                  {genSource === 'swiped' && (
                    <span className="ml-2 px-2.5 py-0.5 bg-orange-100 text-orange-700 text-xs font-medium rounded-full">
                      Swipe Mode
                    </span>
                  )}
                </h3>
                <GenerationProgress phases={genPhases} currentPhase={currentGenPhase} />
              </div>
            )}

            {/* Code Result Section */}
            {displayCode && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                {/* Code Tabs */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
                  <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setCodeViewTab('preview')}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        codeViewTab === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Eye className="w-4 h-4" />
                      Preview
                    </button>
                    <button
                      onClick={() => setCodeViewTab('code')}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        codeViewTab === 'code' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <Code className="w-4 h-4" />
                      HTML Code
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyCode}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      {codeCopied ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      {codeCopied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={downloadCode}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>
                </div>

                {/* Preview Tab */}
                {codeViewTab === 'preview' && (
                  <div className="bg-gray-100 p-4">
                    <div className="bg-white rounded-lg shadow-lg overflow-hidden border border-gray-300 mx-auto" style={{ maxWidth: 700 }}>
                      <div className="bg-gray-200 px-4 py-2 flex items-center gap-2">
                        <div className="flex gap-1.5">
                          <div className="w-3 h-3 rounded-full bg-red-400" />
                          <div className="w-3 h-3 rounded-full bg-yellow-400" />
                          <div className="w-3 h-3 rounded-full bg-green-400" />
                        </div>
                        <div className="flex-1 bg-white rounded-md px-3 py-1 text-xs text-gray-500 text-center truncate">
                          replica-preview.html
                        </div>
                      </div>
                      <iframe
                        ref={iframeRef}
                        srcDoc={displayCode}
                        title="Quiz Preview"
                        className="w-full border-0"
                        style={{ height: 700 }}
                        sandbox="allow-scripts allow-forms"
                      />
                    </div>
                  </div>
                )}

                {/* Code Tab */}
                {codeViewTab === 'code' && (
                  <div className="bg-gray-900 overflow-hidden">
                    <pre className="p-5 text-sm text-gray-300 overflow-x-auto max-h-[700px] overflow-y-auto font-mono leading-relaxed whitespace-pre">
                      {displayCode}
                    </pre>
                  </div>
                )}

              </div>
            )}

            {/* ═══ SWIPE ANALYSIS SECTION ═══ */}
            {analysis && (
              <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 rounded-xl shadow-sm border border-amber-200 overflow-hidden">
                <div className="px-6 py-5 border-b border-amber-200">
                  <h3 className="font-bold text-amber-900 text-lg flex items-center gap-2.5">
                    <Repeat className="w-6 h-6 text-amber-600" />
                    Swipe Analysis
                  </h3>
                  <p className="text-amber-700/70 text-sm mt-1">
                    Enter your product info. Claude will generate branding for your brand inspired by the original analysis, then regenerate a new &quot;swiped&quot; analysis.
                  </p>
                </div>

                <div className="p-6">
                  {/* Product Info Form */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div>
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Product/Brand Name *
                      </label>
                      <input
                        type="text"
                        value={productInfo.product_name}
                        onChange={(e) => updateProductField('product_name', e.target.value)}
                        placeholder="E.g. FitLife Pro"
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white"
                        disabled={isSwiping}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Industry/Sector
                      </label>
                      <input
                        type="text"
                        value={productInfo.industry}
                        onChange={(e) => updateProductField('industry', e.target.value)}
                        placeholder="E.g. Fitness, Skincare, SaaS..."
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white"
                        disabled={isSwiping}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Product Description *
                      </label>
                      <textarea
                        value={productInfo.product_description}
                        onChange={(e) => updateProductField('product_description', e.target.value)}
                        placeholder="Briefly describe your product or service..."
                        rows={2}
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white resize-none"
                        disabled={isSwiping}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Target Audience
                      </label>
                      <input
                        type="text"
                        value={productInfo.target_audience}
                        onChange={(e) => updateProductField('target_audience', e.target.value)}
                        placeholder="E.g. Women 25-45 who want to lose weight"
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white"
                        disabled={isSwiping}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Tone of Voice
                      </label>
                      <input
                        type="text"
                        value={productInfo.tone_of_voice}
                        onChange={(e) => updateProductField('tone_of_voice', e.target.value)}
                        placeholder="E.g. Professional, Friendly, Energetic..."
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white"
                        disabled={isSwiping}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold text-amber-800 mb-1.5">
                        Unique Selling Points (USP)
                      </label>
                      <textarea
                        value={productInfo.unique_selling_points}
                        onChange={(e) => updateProductField('unique_selling_points', e.target.value)}
                        placeholder="What makes your product unique? E.g. 100% natural, results in 30 days..."
                        rows={2}
                        className="w-full px-4 py-2.5 border border-amber-300 rounded-xl focus:ring-2 focus:ring-amber-500 focus:border-transparent outline-none bg-white resize-none"
                        disabled={isSwiping}
                      />
                    </div>
                  </div>

                  {/* Swipe Button */}
                  <button
                    onClick={runSwipeAnalysis}
                    disabled={!isProductInfoValid || isSwiping || isGenerating}
                    className="w-full flex items-center justify-center gap-2.5 px-6 py-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl hover:from-amber-600 hover:to-orange-600 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed font-bold text-base shadow-lg shadow-amber-200 disabled:shadow-none"
                  >
                    {isSwiping ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : currentSwipePhase === 'done' ? (
                      <RefreshCw className="w-5 h-5" />
                    ) : (
                      <Repeat className="w-5 h-5" />
                    )}
                    <span>
                      {isSwiping
                        ? 'Swiping in progress...'
                        : currentSwipePhase === 'done'
                          ? 'Regenerate Swipe'
                          : 'Launch Swipe Analysis'}
                    </span>
                  </button>

                  {/* Swipe Progress */}
                  {swipePhases.length > 0 && (
                    <div className="mt-5">
                      <SwipeProgress phases={swipePhases} currentPhase={currentSwipePhase} />
                    </div>
                  )}
                </div>

                {/* Swiped Results */}
                {(swipedAnalysis || myBranding) && (
                  <div className="border-t border-amber-200">
                    {/* ── GENERATE SWIPED REPLICA BUTTON ── */}
                    {swipedAnalysis && (
                      <div className="px-6 py-5 bg-gradient-to-r from-orange-50 to-amber-50 border-b border-amber-200">
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <h4 className="font-bold text-amber-900 flex items-center gap-2">
                              <Zap className="w-5 h-5 text-orange-500" />
                              Generate HTML with Your Branding
                            </h4>
                            <p className="text-amber-700/70 text-sm mt-0.5">
                              Same structure as the original screenshot, but with your swiped brand colors, texts, and CTAs.
                            </p>
                          </div>
                          <button
                            onClick={() => runCodeGeneration(true)}
                            disabled={isGenerating || isSwiping}
                            className="shrink-0 flex items-center gap-2.5 px-6 py-3.5 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-xl hover:from-orange-600 hover:to-amber-600 transition-all disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed font-bold shadow-lg shadow-orange-200 disabled:shadow-none"
                          >
                            {isGenerating && genSource === 'swiped' ? (
                              <Loader2 className="w-5 h-5 animate-spin" />
                            ) : currentGenPhase === 'done' && genSource === 'swiped' ? (
                              <RefreshCw className="w-5 h-5" />
                            ) : (
                              <Repeat className="w-5 h-5" />
                            )}
                            <span>
                              {isGenerating && genSource === 'swiped'
                                ? 'Swiping in progress...'
                                : currentGenPhase === 'done' && genSource === 'swiped'
                                  ? 'Regenerate Swiped'
                                  : 'Generate Swiped Replica'}
                            </span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Tabs */}
                    <div className="flex items-center gap-1 px-6 py-3 bg-amber-100/50 border-b border-amber-200">
                      <button
                        onClick={() => setSwipeViewTab('visual')}
                        className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          swipeViewTab === 'visual' ? 'bg-white text-amber-800 shadow-sm' : 'text-amber-600 hover:bg-amber-100'
                        }`}
                      >
                        <Eye className="w-4 h-4" />
                        Visual Result
                      </button>
                      {myBranding && (
                        <button
                          onClick={() => setSwipeViewTab('branding-json')}
                          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            swipeViewTab === 'branding-json' ? 'bg-white text-amber-800 shadow-sm' : 'text-amber-600 hover:bg-amber-100'
                          }`}
                        >
                          <Wand2 className="w-4 h-4" />
                          Branding JSON
                        </button>
                      )}
                      {swipedAnalysisRaw && (
                        <button
                          onClick={() => setSwipeViewTab('swiped-json')}
                          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            swipeViewTab === 'swiped-json' ? 'bg-white text-amber-800 shadow-sm' : 'text-amber-600 hover:bg-amber-100'
                          }`}
                        >
                          <MessageSquare className="w-4 h-4" />
                          Analysis JSON
                        </button>
                      )}
                      {/* Copy button */}
                      <div className="ml-auto">
                        <button
                          onClick={() => navigator.clipboard.writeText(JSON.stringify(swipedAnalysisRaw || myBranding, null, 2))}
                          className="flex items-center gap-1.5 px-3 py-2 text-sm text-amber-600 hover:bg-amber-100 rounded-lg transition-colors"
                        >
                          <Copy className="w-4 h-4" />
                          Copy
                        </button>
                      </div>
                    </div>

                    <div className="p-6">
                      {swipeViewTab === 'visual' && swipedAnalysis && analysis && (
                        <SwipedAnalysisDisplay swiped={swipedAnalysis} original={analysis} />
                      )}
                      {swipeViewTab === 'branding-json' && myBranding && (
                        <div className="bg-gray-900 rounded-xl overflow-hidden">
                          <div className="px-5 py-2.5 bg-gray-800">
                            <span className="text-amber-400 text-sm font-mono">My Branding (Claude)</span>
                          </div>
                          <pre className="p-5 text-sm text-amber-400 overflow-x-auto max-h-[600px] overflow-y-auto font-mono leading-relaxed">
                            {JSON.stringify(myBranding, null, 2)}
                          </pre>
                        </div>
                      )}
                      {swipeViewTab === 'swiped-json' && swipedAnalysisRaw && (
                        <div className="bg-gray-900 rounded-xl overflow-hidden">
                          <div className="px-5 py-2.5 bg-gray-800">
                            <span className="text-orange-400 text-sm font-mono">Swiped Analysis (Claude)</span>
                          </div>
                          <pre className="p-5 text-sm text-orange-400 overflow-x-auto max-h-[600px] overflow-y-auto font-mono leading-relaxed">
                            {JSON.stringify(swipedAnalysisRaw, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Analysis Section (collapsible when code is generated) */}
            {analysis && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setAnalysisCollapsed(!analysisCollapsed)}
                  className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                >
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                    <Eye className="w-5 h-5 text-indigo-500" />
                    Gemini Vision AI Branding Analysis
                  </h3>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-3 py-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveTab('visual'); setAnalysisCollapsed(false); }}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${activeTab === 'visual' ? 'bg-indigo-600 text-white' : 'text-gray-500'}`}
                      >
                        Visual
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveTab('json'); setAnalysisCollapsed(false); }}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${activeTab === 'json' ? 'bg-indigo-600 text-white' : 'text-gray-500'}`}
                      >
                        JSON
                      </button>
                    </div>
                    {analysisCollapsed ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronUp className="w-5 h-5 text-gray-400" />}
                  </div>
                </button>

                {!analysisCollapsed && (
                  <div className="px-5 pb-5">
                    {activeTab === 'visual' ? (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <SectionCard icon={Target} title="Brand Identity" color="bg-indigo-50 text-indigo-700">
                          <div className="space-y-0.5">
                            <InfoRow label="Brand Name" value={analysis.brand_identity?.brand_name} />
                            <InfoRow label="Logo" value={analysis.brand_identity?.logo_description} />
                            <InfoRow label="Personality" value={analysis.brand_identity?.brand_personality} />
                            <InfoRow label="Target Audience" value={analysis.brand_identity?.target_audience} />
                            <InfoRow label="Industry" value={analysis.brand_identity?.industry} />
                          </div>
                        </SectionCard>

                        <SectionCard icon={Palette} title="Color Palette" color="bg-pink-50 text-pink-700">
                          <div className="space-y-4">
                            <div className="flex flex-wrap gap-4">
                              {analysis.color_palette?.primary_color && <ColorSwatch color={analysis.color_palette.primary_color} label="Primary" />}
                              {analysis.color_palette?.secondary_color && <ColorSwatch color={analysis.color_palette.secondary_color} label="Secondary" />}
                              {analysis.color_palette?.accent_color && <ColorSwatch color={analysis.color_palette.accent_color} label="Accent" />}
                              {analysis.color_palette?.background_color && <ColorSwatch color={analysis.color_palette.background_color} label="Background" />}
                              {analysis.color_palette?.text_color && <ColorSwatch color={analysis.color_palette.text_color} label="Text" />}
                            </div>
                            {analysis.color_palette?.all_colors?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-2 font-medium">All detected colors</p>
                                <div className="flex gap-1 flex-wrap">
                                  {analysis.color_palette.all_colors.map((c, i) => (
                                    <div key={i} className="w-8 h-8 rounded-lg border border-gray-200 shadow-sm cursor-pointer hover:scale-125 transition-transform" style={{ backgroundColor: c }} title={c} onClick={() => navigator.clipboard.writeText(c)} />
                                  ))}
                                </div>
                              </div>
                            )}
                            <div className="pt-2 border-t border-gray-100 space-y-0.5">
                              <InfoRow label="Schema" value={analysis.color_palette?.color_scheme_type} />
                              <InfoRow label="Mood" value={analysis.color_palette?.color_mood} />
                            </div>
                          </div>
                        </SectionCard>

                        <SectionCard icon={Type} title="Typography" color="bg-amber-50 text-amber-700">
                          <div className="space-y-0.5">
                            <InfoRow label="Heading Font" value={analysis.typography?.heading_font_style} />
                            <InfoRow label="Body Font" value={analysis.typography?.body_font_style} />
                            <InfoRow label="Weights" value={analysis.typography?.font_weight_pattern} />
                            <InfoRow label="Hierarchy" value={analysis.typography?.text_hierarchy} />
                          </div>
                        </SectionCard>

                        <SectionCard icon={Layout} title="Layout Structure" color="bg-green-50 text-green-700">
                          <div className="space-y-3">
                            <div className="space-y-0.5">
                              <InfoRow label="Layout Type" value={analysis.layout_structure?.layout_type} />
                              <InfoRow label="Navigation" value={analysis.layout_structure?.navigation_style} />
                              <InfoRow label="Hero Section" value={analysis.layout_structure?.hero_section} />
                              <InfoRow label="Density" value={analysis.layout_structure?.content_density} />
                              <InfoRow label="Whitespace" value={analysis.layout_structure?.whitespace_usage} />
                            </div>
                            {analysis.layout_structure?.sections?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Sections</p>
                                <TagList tags={analysis.layout_structure.sections} colorClass="bg-green-100 text-green-700" />
                              </div>
                            )}
                          </div>
                        </SectionCard>

                        <SectionCard icon={Layers} title="Visual Elements" color="bg-cyan-50 text-cyan-700">
                          <div className="space-y-3">
                            <div className="space-y-0.5">
                              <InfoRow label="Images" value={analysis.visual_elements?.images_style} />
                              <InfoRow label="Icons" value={analysis.visual_elements?.icons_style} />
                              <InfoRow label="Buttons" value={analysis.visual_elements?.buttons_style} />
                              <InfoRow label="Card" value={analysis.visual_elements?.cards_style} />
                              <InfoRow label="Animations" value={analysis.visual_elements?.animations_detected} />
                            </div>
                            {analysis.visual_elements?.decorative_elements?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Decorative elements</p>
                                <TagList tags={analysis.visual_elements.decorative_elements} colorClass="bg-cyan-100 text-cyan-700" />
                              </div>
                            )}
                          </div>
                        </SectionCard>

                        <SectionCard icon={MousePointer} title="CTA Analysis" color="bg-orange-50 text-orange-700">
                          <div className="space-y-3">
                            <div className="space-y-0.5">
                              <InfoRow label="Primary CTA" value={analysis.cta_analysis?.primary_cta_text} />
                              <InfoRow label="CTA Style" value={analysis.cta_analysis?.primary_cta_style} />
                              <InfoRow label="Placement" value={analysis.cta_analysis?.cta_placement} />
                            </div>
                            {analysis.cta_analysis?.secondary_ctas?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Secondary CTAs</p>
                                <TagList tags={analysis.cta_analysis.secondary_ctas} colorClass="bg-orange-100 text-orange-700" />
                              </div>
                            )}
                          </div>
                        </SectionCard>

                        <SectionCard icon={Sparkles} title="Quiz / Funnel Elements" color="bg-purple-50 text-purple-700">
                          <div className="space-y-0.5">
                            <div className="flex gap-2 py-1.5">
                              <span className="text-sm text-gray-500 shrink-0 w-36">Quiz Funnel?</span>
                              <span className={`text-sm font-bold ${analysis.quiz_funnel_elements?.is_quiz_funnel ? 'text-green-600' : 'text-gray-400'}`}>
                                {analysis.quiz_funnel_elements?.is_quiz_funnel ? 'Yes' : 'No'}
                              </span>
                            </div>
                            <InfoRow label="Quiz Type" value={analysis.quiz_funnel_elements?.quiz_type} />
                            <InfoRow label="Question Style" value={analysis.quiz_funnel_elements?.question_style} />
                            <InfoRow label="Answer Format" value={analysis.quiz_funnel_elements?.answer_format} />
                            <InfoRow label="Progress" value={analysis.quiz_funnel_elements?.progress_indicator} />
                            <InfoRow label="Steps Detected" value={analysis.quiz_funnel_elements?.steps_detected != null ? String(analysis.quiz_funnel_elements.steps_detected) : null} />
                          </div>
                        </SectionCard>

                        <SectionCard icon={TrendingUp} title="Overall Assessment" color="bg-rose-50 text-rose-700">
                          <div className="space-y-4">
                            <div className="space-y-3">
                              <ScoreBar score={analysis.overall_assessment?.design_quality_score ?? 0} label="Design Quality" />
                              <ScoreBar score={analysis.overall_assessment?.modernity_score ?? 0} label="Modernity" />
                              <ScoreBar score={analysis.overall_assessment?.conversion_optimization_score ?? 0} label="Conversion Optimization" />
                            </div>
                            <InfoRow label="Mobile Ready" value={analysis.overall_assessment?.mobile_readiness_estimate} />
                            {analysis.overall_assessment?.design_style_tags?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Design Style</p>
                                <TagList tags={analysis.overall_assessment.design_style_tags} colorClass="bg-rose-100 text-rose-700" />
                              </div>
                            )}
                            {analysis.overall_assessment?.key_strengths?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Key Strengths</p>
                                <ul className="space-y-1">
                                  {analysis.overall_assessment.key_strengths.map((s, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                                      <Star className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />{s}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {analysis.overall_assessment?.improvement_suggestions?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 mb-1.5 font-medium">Improvement Suggestions</p>
                                <ul className="space-y-1">
                                  {analysis.overall_assessment.improvement_suggestions.map((s, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                                      <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />{s}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </SectionCard>
                      </div>
                    ) : (
                      <div className="bg-gray-900 rounded-xl overflow-hidden shadow-lg">
                        <div className="flex items-center justify-between px-5 py-3 bg-gray-800">
                          <span className="text-gray-400 text-sm font-mono">Gemini Vision AI Response</span>
                          <button onClick={copyFullJson} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition-colors">
                            <Copy className="w-4 h-4" />
                            Copy JSON
                          </button>
                        </div>
                        <pre className="p-5 text-sm text-green-400 overflow-x-auto max-h-[700px] overflow-y-auto font-mono leading-relaxed">
                          {JSON.stringify(result.analysis, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Raw text fallback */}
            {result.analysisRaw && !analysis && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2.5">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                  <h3 className="font-semibold text-gray-900">Gemini Response (raw - JSON parsing failed)</h3>
                </div>
                <pre className="p-5 text-sm text-gray-700 overflow-x-auto whitespace-pre-wrap max-h-[500px] overflow-y-auto">{result.analysisRaw}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
