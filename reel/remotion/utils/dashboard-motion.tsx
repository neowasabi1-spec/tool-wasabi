import React from "react";
import { interpolate, useCurrentFrame } from "remotion";

/**
 * Primitive di micro-motion riusabili per le dashboard animate dei reel.
 *
 * Obiettivo (recipe 2026-06-01, vedi reel-engine/CLAUDE.md → "Dashboard animate"):
 * quando genero un componente dashboard da un brief/copy, lo compongo con queste
 * primitive così esce ANIMATO per costruzione (count-up, reveal staggerato,
 * grow di barre/funnel, donut sweep) invece che come PNG statico + Ken Burns.
 *
 * Tutto è frame-based e deterministico (no Date.now/Math.random) → render Remotion
 * riproducibile. Validato sul pilot owner-animated (2026-06-01).
 *
 * Convenzioni timing (a 30fps):
 *   - reveal pannello/surface: dur ~14 frame
 *   - count-up numero hero:    dur ~30-36 frame
 *   - grow barra/funnel:       dur ~14-18 frame
 *   - donut sweep:             dur ~46 frame
 * Stagger consigliato tra elementi: 8-10 frame.
 */

/** Progress 0→1 su una finestra [start, start+dur], clampato ai due estremi. */
export const ramp = (frame: number, start: number, dur: number): number =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** Formattazione numeri stile italiano (separatore migliaia "."). */
export const fmtIt = (n: number): string => Math.round(n).toLocaleString("it-IT");

/** Stile di reveal (opacità + slide-up) per una finestra di frame. */
export const useReveal = (
  start: number,
  dur = 14,
  dy = 18
): { opacity: number; transform: string } => {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, dur);
  return { opacity: p, transform: `translateY(${(1 - p) * dy}px)` };
};

/** Valore corrente di un count-up 0→target sulla finestra [start, start+dur]. */
export const useCountUp = (target: number, start: number, dur = 30): number => {
  const frame = useCurrentFrame();
  return Math.round(target * ramp(frame, start, dur));
};

/** Progress 0→1 di una crescita (barra/funnel) — alias semantico di ramp(frame,...). */
export const useGrow = (start: number, dur = 16): number => {
  const frame = useCurrentFrame();
  return ramp(frame, start, dur);
};

/** Wrapper che rivela i children (opacità + slide-up). */
export const Reveal: React.FC<{
  start: number;
  dur?: number;
  dy?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ start, dur = 14, dy = 18, style, children }) => {
  const r = useReveal(start, dur, dy);
  return <div style={{ ...r, ...style }}>{children}</div>;
};

/** Numero count-up renderizzato inline (eredita lo stile dal parent). */
export const CountUp: React.FC<{
  target: number;
  start: number;
  dur?: number;
  format?: (n: number) => string;
  prefix?: string;
  suffix?: string;
}> = ({ target, start, dur = 30, format = fmtIt, prefix = "", suffix = "" }) => {
  const v = useCountUp(target, start, dur);
  return (
    <>
      {prefix}
      {format(v)}
      {suffix}
    </>
  );
};

export interface DonutSegment {
  value: number;
  color: string;
}

/**
 * Donut a "snake fill" progressivo: i segmenti si riempiono in sequenza in base
 * a `reveal` (0→1). Il testo centrale (label + valore) è passato dal chiamante,
 * tipicamente con un valore in count-up sincronizzato allo stesso reveal.
 */
export const DonutSweep: React.FC<{
  size: number;
  segments: DonutSegment[];
  reveal: number;
  strokeWidth?: number;
  trackColor: string;
  centerLabel?: string;
  centerValue?: string;
  labelColor?: string;
  valueColor?: string;
  labelFont?: string;
  valueFont?: string;
}> = ({
  size,
  segments,
  reveal,
  strokeWidth = 36,
  trackColor,
  centerLabel,
  centerValue,
  labelColor = "#9A988F",
  valueColor = "#E8E1D2",
  labelFont,
  valueFont,
}) => {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - strokeWidth;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const lens = segments.map((s) => (s.value / total) * C);
  let before = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
      <circle cx={cx} cy={cy} r={r} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
      {segments.map((seg, i) => {
        const drawn = Math.min(Math.max(reveal * C - before, 0), lens[i]);
        const offset = -before;
        before += lens[i];
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            stroke={seg.color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={`${drawn} ${C - drawn}`}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${cx} ${cy})`}
            strokeLinecap="butt"
          />
        );
      })}
      {centerLabel && (
        <text x={cx} y={cy - 12} textAnchor="middle" style={{ fontSize: 22, letterSpacing: 2, fill: labelColor, fontFamily: labelFont }}>
          {centerLabel}
        </text>
      )}
      {centerValue !== undefined && (
        <text x={cx} y={cy + 50} textAnchor="middle" style={{ fontSize: 86, fontWeight: 600, fill: valueColor, fontFamily: valueFont }}>
          {centerValue}
        </text>
      )}
    </svg>
  );
};

/** Barra orizzontale che cresce in larghezza (per liste/canali). */
export const GrowBar: React.FC<{
  pct: number; // 0-100 target
  grow: number; // 0-1 progress
  color: string;
  trackColor: string;
  height?: number;
}> = ({ pct, grow, color, trackColor, height = 6 }) => (
  <div style={{ height, background: trackColor, borderRadius: height / 2 }}>
    <div style={{ height: "100%", width: `${pct * grow}%`, background: color, borderRadius: height / 2 }} />
  </div>
);
