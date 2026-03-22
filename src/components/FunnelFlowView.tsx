'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { AffiliateSavedFunnel, Json } from '@/types/database';
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ExternalLink,
  Globe,
  Zap,
  FileStack,
  Tag,
  Sparkles,
  GripHorizontal,
  Move,
  Image as ImageIcon,
  Link2,
  Loader2,
} from 'lucide-react';
import CachedScreenshot from '@/components/CachedScreenshot';

/* ────────── Types ────────── */

interface FunnelStep {
  step_index: number;
  url?: string;
  title?: string;
  step_type?: string;
  input_type?: string;
  options?: string[];
  description?: string;
  cta_text?: string;
}

interface NodePos { x: number; y: number }

interface FunnelFlowViewProps {
  funnel: AffiliateSavedFunnel;
  onClose: () => void;
}

const BLOCK_W = 210;
const BLOCK_H = 200;
const GAP_X = 100;
const GAP_Y = 60;
const COLS = 4;

const STEP_COLORS: Record<string, { bg: string; border: string; dot: string; text: string }> = {
  quiz_question: { bg: '#f5f3ff', border: '#c4b5fd', dot: '#8b5cf6', text: '#6d28d9' },
  info_screen:   { bg: '#f0f9ff', border: '#93c5fd', dot: '#3b82f6', text: '#1d4ed8' },
  lead_capture:  { bg: '#f0fdfa', border: '#5eead4', dot: '#14b8a6', text: '#0f766e' },
  checkout:      { bg: '#ecfdf5', border: '#6ee7b7', dot: '#10b981', text: '#047857' },
  upsell:        { bg: '#fffbeb', border: '#fcd34d', dot: '#f59e0b', text: '#b45309' },
  thank_you:     { bg: '#f0fdf4', border: '#86efac', dot: '#22c55e', text: '#15803d' },
  landing:       { bg: '#eff6ff', border: '#93c5fd', dot: '#3b82f6', text: '#1e40af' },
  other:         { bg: '#f8fafc', border: '#cbd5e1', dot: '#94a3b8', text: '#475569' },
};

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

function parseSteps(raw: Json): FunnelStep[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as FunnelStep[];
}

function buildInitialPositions(count: number): NodePos[] {
  const positions: NodePos[] = [];
  const offsetX = 80 + GAP_X;
  for (let i = 0; i < count; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const isEvenRow = row % 2 === 0;
    const x = offsetX + (isEvenRow ? col : COLS - 1 - col) * (BLOCK_W + GAP_X);
    const y = 60 + row * (BLOCK_H + GAP_Y);
    positions.push({ x, y });
  }
  return positions;
}

/* ────────── StepPreview ────────── */

function StepPreview({ url, title, screenshotBase64 }: { url: string; title: string; screenshotBase64?: string }) {
  if (screenshotBase64) {
    return (
      <div className="relative w-full h-full bg-white overflow-hidden">
        <img
          src={`data:image/png;base64,${screenshotBase64}`}
          alt={`Preview: ${title}`}
          className="w-full h-full object-cover object-top"
          draggable={false}
        />
      </div>
    );
  }

  if (url) {
    return (
      <div className="relative w-full h-full bg-white overflow-hidden">
        <CachedScreenshot
          url={url}
          alt={`Preview: ${title}`}
          className="w-full"
          height="100%"
        />
      </div>
    );
  }

  let hostname = '';
  try { hostname = url ? new URL(url).hostname : ''; } catch { /* */ }

  return (
    <div className="flex flex-col items-center justify-center h-full bg-gradient-to-br from-slate-50 to-slate-100 gap-1 px-2">
      {hostname ? (
        <>
          <img src={`https://www.google.com/s2/favicons?sz=32&domain=${hostname}`} alt="" className="h-6 w-6 rounded" />
          <p className="text-[7px] text-slate-400 text-center leading-tight truncate w-full" title={url}>
            {hostname}
          </p>
        </>
      ) : (
        <>
          <ImageIcon className="h-5 w-5 text-slate-300" />
          <p className="text-[7px] text-slate-400">No URL</p>
        </>
      )}
    </div>
  );
}

/* ────────── SVG Connectors ────────── */

function Connectors({ positions, startNode, endNode }: { positions: NodePos[]; startNode: NodePos; endNode: NodePos | null }) {
  if (positions.length === 0) return null;

  const pts = [startNode, ...positions, ...(endNode ? [endNode] : [])];
  const maxX = Math.max(...pts.map((p) => p.x)) + BLOCK_W + 200;
  const maxY = Math.max(...pts.map((p) => p.y)) + BLOCK_H + 200;

  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];

  lines.push({
    x1: startNode.x + 56,
    y1: startNode.y + 24,
    x2: positions[0].x,
    y2: positions[0].y + BLOCK_H / 2,
  });

  for (let i = 0; i < positions.length - 1; i++) {
    const from = positions[i];
    const to = positions[i + 1];
    lines.push({
      x1: from.x + BLOCK_W / 2,
      y1: from.y + BLOCK_H / 2,
      x2: to.x + BLOCK_W / 2,
      y2: to.y + BLOCK_H / 2,
    });
  }

  if (endNode && positions.length > 0) {
    const last = positions[positions.length - 1];
    lines.push({
      x1: last.x + BLOCK_W / 2,
      y1: last.y + BLOCK_H / 2,
      x2: endNode.x + 24,
      y2: endNode.y + 24,
    });
  }

  return (
    <svg className="absolute top-0 left-0 pointer-events-none" style={{ width: maxX, height: maxY }}>
      <defs>
        <marker id="arrHead" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
          <polygon points="0 0, 6 2.5, 0 5" fill="#22c55e" />
        </marker>
      </defs>
      {lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#d1d5db" strokeWidth="1.2" markerEnd="url(#arrHead)" />
      ))}
      {lines.map((l, i) => (
        <g key={`d-${i}`}>
          <circle cx={l.x1} cy={l.y1} r="2.5" fill="#22c55e" />
          <circle cx={l.x2} cy={l.y2} r="2.5" fill="#22c55e" />
        </g>
      ))}
    </svg>
  );
}

/* ────────── Main Component ────────── */

export default function FunnelFlowView({ funnel, onClose }: FunnelFlowViewProps) {
  const steps = parseSteps(funnel.steps);
  const canvasRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.85);
  const [positions, setPositions] = useState<NodePos[]>(() => buildInitialPositions(steps.length));
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [, forceRender] = useState(0);

  const [screenshots, setScreenshots] = useState<Record<string, string>>({});
  const [screenshotsLoading, setScreenshotsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadScreenshots() {
      try {
        const res = await fetch('/api/swipe-quiz/fetch-screenshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entryUrl: funnel.entry_url,
            funnelName: funnel.funnel_name,
          }),
        });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        if (cancelled) return;
        if (data.success && data.steps) {
          const map: Record<string, string> = {};
          for (const s of data.steps) {
            if (s.url) map[s.url] = s.screenshotBase64;
            if (s.stepIndex != null) map[`idx:${s.stepIndex}`] = s.screenshotBase64;
          }
          setScreenshots(map);
        }
      } catch {
        // Screenshots not available — fallback UI will show
      } finally {
        if (!cancelled) setScreenshotsLoading(false);
      }
    }
    loadScreenshots();
    return () => { cancelled = true; };
  }, [funnel.entry_url, funnel.funnel_name]);

  /* ── Drag state in refs so handlers read instantly ── */
  const dragRef = useRef<{
    idx: number;
    startMouseX: number;
    startMouseY: number;
    startBlockX: number;
    startBlockY: number;
  } | null>(null);

  const panRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startScrollX: number;
    startScrollY: number;
  } | null>(null);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  /* ── Window-level mouse handlers ── */
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        e.preventDefault();
        const d = dragRef.current;
        const z = zoomRef.current;
        const dx = (e.clientX - d.startMouseX) / z;
        const dy = (e.clientY - d.startMouseY) / z;
        setPositions((prev) => {
          const next = [...prev];
          next[d.idx] = {
            x: Math.max(0, d.startBlockX + dx),
            y: Math.max(0, d.startBlockY + dy),
          };
          return next;
        });
      } else if (panRef.current && canvasRef.current) {
        const p = panRef.current;
        canvasRef.current.scrollLeft = p.startScrollX - (e.clientX - p.startMouseX);
        canvasRef.current.scrollTop = p.startScrollY - (e.clientY - p.startMouseY);
      }
    };

    const handleMouseUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        forceRender((n) => n + 1);
      }
      if (panRef.current) {
        panRef.current = null;
        forceRender((n) => n + 1);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  /* ── Block drag start ── */
  const handleBlockMouseDown = useCallback(
    (e: React.MouseEvent, idx: number) => {
      e.stopPropagation();
      e.preventDefault();
      const pos = positionsRef.current[idx];
      dragRef.current = {
        idx,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startBlockX: pos.x,
        startBlockY: pos.y,
      };
      forceRender((n) => n + 1);
    },
    [],
  );

  /* ── Canvas pan start ── */
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-block]') || target.closest('a') || target.closest('button')) return;
      panRef.current = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startScrollX: canvasRef.current?.scrollLeft ?? 0,
        startScrollY: canvasRef.current?.scrollTop ?? 0,
      };
      forceRender((n) => n + 1);
    },
    [],
  );

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(Math.max(z + (e.deltaY > 0 ? -0.05 : 0.05), 0.2), 2.5));
  }, []);

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.15, 2.5));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.15, 0.2));
  const handleZoomReset = () => setZoom(1);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom((z) => Math.min(z + 0.1, 2.5)); }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom((z) => Math.max(z - 0.1, 0.2)); }
      if (e.key === '0') { e.preventDefault(); setZoom(1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isDragging = dragRef.current !== null;
  const isPanning = panRef.current !== null;
  const dragIdx = dragRef.current?.idx ?? null;

  const startNode: NodePos = { x: 30, y: 80 };
  const endNode: NodePos | null = useMemo(() => {
    if (positions.length === 0) return null;
    const last = positions[positions.length - 1];
    const lastRow = Math.floor((positions.length - 1) / COLS);
    const isEvenRow = lastRow % 2 === 0;
    return {
      x: isEvenRow ? last.x + BLOCK_W + GAP_X : last.x - GAP_X - 80,
      y: last.y + BLOCK_H / 2 - 24,
    };
  }, [positions]);

  const canvasW = useMemo(() => Math.max(...positions.map((p) => p.x), endNode?.x ?? 0, 0) + BLOCK_W + 400, [positions, endNode]);
  const canvasH = useMemo(() => Math.max(...positions.map((p) => p.y), endNode?.y ?? 0, 0) + BLOCK_H + 300, [positions, endNode]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-5 py-2.5 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100">
            <FileStack className="h-4 w-4 text-amber-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-800 truncate">{funnel.funnel_name}</h2>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">{FUNNEL_TYPE_LABELS[funnel.funnel_type] ?? funnel.funnel_type}</span>
              <span className="text-slate-300">&middot;</span>
              <span className="text-[11px] text-slate-400">{steps.length} pages</span>
              {funnel.brand_name && (
                <>
                  <span className="text-slate-300">&middot;</span>
                  <span className="text-[11px] text-slate-400">{funnel.brand_name}</span>
                </>
              )}
              <span className="text-slate-300">&middot;</span>
              <a
                href={funnel.entry_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-amber-600 hover:text-amber-500 transition-colors truncate max-w-[260px]"
                title={funnel.entry_url}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{funnel.entry_url.replace(/^https?:\/\//, '')}</span>
              </a>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg px-1.5 py-0.5 border border-slate-200">
            <button onClick={handleZoomOut} className="p-1 rounded text-slate-500 hover:text-slate-800 hover:bg-white transition-colors" title="Zoom out">
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="text-[11px] text-slate-500 font-mono min-w-[36px] text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={handleZoomIn} className="p-1 rounded text-slate-500 hover:text-slate-800 hover:bg-white transition-colors" title="Zoom in">
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <div className="w-px h-3 bg-slate-300 mx-0.5" />
            <button onClick={handleZoomReset} className="p-1 rounded text-slate-500 hover:text-slate-800 hover:bg-white transition-colors" title="Reset zoom">
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <button onClick={onClose} className="ml-1 rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* ── Canvas ── */}
      <div
        ref={canvasRef}
        className={`flex-1 overflow-auto relative ${isDragging ? 'cursor-grabbing' : isPanning ? 'cursor-grabbing' : 'cursor-default'}`}
        onWheel={handleWheel}
        onMouseDown={handleCanvasMouseDown}
        style={{
          backgroundImage: 'radial-gradient(circle, #e2e8f0 0.8px, transparent 0.8px)',
          backgroundSize: '20px 20px',
          backgroundColor: '#f8fafc',
        }}
      >
        <div
          ref={innerRef}
          style={{
            width: canvasW,
            height: canvasH,
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            position: 'relative',
          }}
        >
          <Connectors positions={positions} startNode={startNode} endNode={endNode} />

          {/* Start node */}
          <div className="absolute flex flex-col items-center gap-1" style={{ left: startNode.x, top: startNode.y }}>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-md">
              <Globe className="h-6 w-6 text-white" />
            </div>
            <span className="text-[9px] font-medium text-slate-500">Entry</span>
          </div>

          {/* End node */}
          {endNode && (
            <div className="absolute flex flex-col items-center gap-1" style={{ left: endNode.x, top: endNode.y }}>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-green-500 shadow-md">
                <Sparkles className="h-6 w-6 text-white" />
              </div>
              <span className="text-[9px] font-medium text-slate-500">End</span>
            </div>
          )}

          {/* Step blocks */}
          {steps.map((step, idx) => {
            const pos = positions[idx];
            if (!pos) return null;
            const colors = STEP_COLORS[step.step_type ?? 'other'] ?? STEP_COLORS.other;
            const stepIdx = step.step_index ?? idx + 1;
            const isSelected = selectedStep === idx;
            const isDraggingThis = dragIdx === idx;

            return (
              <div
                key={step.step_index ?? idx}
                data-block
                className={`absolute select-none ${isDraggingThis ? 'z-30 opacity-90' : 'z-10'}`}
                style={{ left: pos.x, top: pos.y, width: BLOCK_W }}
              >
                <div
                  className={`rounded-xl border bg-white overflow-hidden transition-shadow ${
                    isSelected
                      ? 'border-amber-400 shadow-lg shadow-amber-100 ring-1 ring-amber-300'
                      : isDraggingThis
                        ? 'border-slate-400 shadow-2xl'
                        : 'border-slate-200 shadow-sm hover:shadow-md'
                  }`}
                  style={{ borderColor: isSelected || isDraggingThis ? undefined : colors.border }}
                >
                  {/* Drag handle + title */}
                  <div
                    className="flex items-center gap-2 px-2.5 py-2 cursor-grab active:cursor-grabbing"
                    style={{ backgroundColor: colors.bg }}
                    onMouseDown={(e) => handleBlockMouseDown(e, idx)}
                  >
                    <Move className="h-3 w-3 shrink-0" style={{ color: colors.dot }} />
                    <div
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white text-[10px] font-bold"
                      style={{ backgroundColor: colors.dot }}
                    >
                      {stepIdx}
                    </div>
                    <p className="flex-1 text-xs font-semibold text-slate-700 truncate">{step.title || 'Untitled'}</p>
                    {step.url && (
                      <a
                        href={step.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 p-0.5 text-slate-400 hover:text-amber-600 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>

                  {/* Preview */}
                  <div
                    className="relative bg-white cursor-pointer"
                    style={{ height: 130 }}
                    onClick={() => setSelectedStep(isSelected ? null : idx)}
                  >
                    {screenshotsLoading ? (
                      <div className="flex flex-col items-center justify-center h-full bg-slate-50/80">
                        <Loader2 className="h-4 w-4 text-slate-300 animate-spin" />
                      </div>
                    ) : step.url ? (
                      <StepPreview
                        url={step.url}
                        title={step.title || `Step ${stepIdx}`}
                        screenshotBase64={screenshots[step.url] || screenshots[`idx:${stepIdx}`]}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full bg-slate-50">
                        <Globe className="h-5 w-5 text-slate-200" />
                        <p className="mt-1 text-[8px] text-slate-400">No URL</p>
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="px-2.5 py-1.5 border-t border-slate-100 bg-slate-50/50 space-y-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      {step.step_type && (
                        <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ backgroundColor: colors.bg, color: colors.text }}>
                          {step.step_type.replace(/_/g, ' ')}
                        </span>
                      )}
                      {step.cta_text && (
                        <span className="inline-flex items-center gap-0.5 text-[9px] text-emerald-600">
                          <Zap className="h-2 w-2" />
                          {step.cta_text}
                        </span>
                      )}
                    </div>
                    {step.url && (
                      <a
                        href={step.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[8px] text-amber-600 hover:text-amber-500 transition-colors truncate"
                        title={step.url}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Link2 className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{step.url.replace(/^https?:\/\//, '')}</span>
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Floating zoom controls ── */}
      <div className="absolute bottom-14 right-5 z-40 flex flex-col items-center bg-white rounded-xl border border-slate-200 shadow-lg overflow-hidden">
        <button
          onClick={handleZoomIn}
          className="flex items-center justify-center w-10 h-10 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors border-b border-slate-100"
          title="Zoom in (+)"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
        <button
          onClick={handleZoomReset}
          className="flex items-center justify-center w-10 h-8 text-[11px] font-mono text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors border-b border-slate-100"
          title="Reset zoom (0)"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={handleZoomOut}
          className="flex items-center justify-center w-10 h-10 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          title="Zoom out (-)"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
      </div>

      {/* ── Bottom bar ── */}
      <div className="px-5 py-2 bg-white border-t border-slate-200 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <GripHorizontal className="h-3 w-3" />
              Drag blocks &middot; Scroll to zoom &middot; +/- keyboard &middot; 0 to reset
            </span>
            <div className="flex items-center gap-2.5">
              {Object.entries(STEP_COLORS).map(([type, c]) => {
                if (!steps.some((s) => s.step_type === type)) return null;
                return (
                  <div key={type} className="flex items-center gap-1">
                    <div className="h-2 w-2 rounded-full" style={{ backgroundColor: c.dot }} />
                    <span className="text-[9px] text-slate-400">{type.replace(/_/g, ' ')}</span>
                  </div>
                );
              })}
            </div>
          </div>
          {funnel.tags.length > 0 && (
            <div className="flex items-center gap-1">
              {funnel.tags.slice(0, 4).map((tag, i) => (
                <span key={i} className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500 border border-slate-200">
                  <Tag className="h-2 w-2" />
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Detail panel ── */}
      {selectedStep !== null && steps[selectedStep] && (() => {
        const s = steps[selectedStep];
        const c = STEP_COLORS[s.step_type ?? 'other'] ?? STEP_COLORS.other;
        const stepIdx = s.step_index ?? selectedStep + 1;
        const stepScreenshot = s.url ? (screenshots[s.url] || screenshots[`idx:${stepIdx}`]) : undefined;
        return (
          <div className="absolute top-14 right-4 w-80 bg-white rounded-xl border border-slate-200 shadow-xl z-40 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100" style={{ backgroundColor: c.bg }}>
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white text-[10px] font-bold" style={{ backgroundColor: c.dot }}>
                  {stepIdx}
                </div>
                <span className="text-xs font-bold text-slate-700 truncate">{s.title || 'Untitled'}</span>
              </div>
              <button onClick={() => setSelectedStep(null)} className="p-0.5 rounded text-slate-400 hover:text-slate-700 transition-colors shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Screenshot preview in detail panel */}
            {stepScreenshot && (
              <div className="border-b border-slate-100">
                <img
                  src={`data:image/png;base64,${stepScreenshot}`}
                  alt={s.title || `Step ${stepIdx}`}
                  className="w-full h-40 object-cover object-top"
                />
              </div>
            )}

            <div className="p-3 space-y-2 max-h-60 overflow-y-auto">
              {s.step_type && (
                <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ backgroundColor: c.bg, color: c.text }}>
                  {s.step_type.replace(/_/g, ' ')}
                </span>
              )}
              {s.description && <p className="text-[11px] text-slate-600 leading-relaxed">{s.description}</p>}
              {s.cta_text && (
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-emerald-500" />
                  <span className="text-[11px] text-emerald-600 font-medium">{s.cta_text}</span>
                </div>
              )}
              {s.options && s.options.length > 0 && (
                <div>
                  <p className="text-[9px] text-slate-400 uppercase tracking-wider mb-1">Options</p>
                  <div className="flex flex-wrap gap-1">
                    {s.options.map((opt, oi) => (
                      <span key={oi} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 border border-slate-200">{opt}</span>
                    ))}
                  </div>
                </div>
              )}
              {s.url && (
                <div className="rounded-lg bg-amber-50/60 border border-amber-200/50 p-2">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-[11px] text-amber-700 hover:text-amber-500 font-medium transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    Open original page
                  </a>
                  <p className="mt-1 text-[9px] text-amber-600/70 break-all leading-relaxed">{s.url}</p>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
