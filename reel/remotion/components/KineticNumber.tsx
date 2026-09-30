import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { spaceFont } from "../utils/fonts";

interface KineticNumberProps {
  value: string;           // es. "391"
  suffix?: string;         // es. "%"
  label?: string;          // es. "probabilità in più"
  source?: string;         // es. "VELOCIFY · STUDIO SU 3,5M LEAD"
  palette?: {
    bg?: string;           // deep ink
    primary?: string;      // gold del numero
    accent?: string;       // amber dei bordi
    label?: string;        // white del label
    source?: string;       // sand del source
  };
}

// Deterministic particle seeds (no Math.random → non-deterministic per Remotion)
const PARTICLES = Array.from({ length: 42 }, (_, i) => {
  const s = (n: number) => ((i * 2654435761 + n * 1597334677) % 2147483647) / 2147483647;
  return {
    id: i,
    startX: 45 + (s(1) - 0.5) * 30,           // center horizontal cluster
    startY: 55 + (s(2) - 0.5) * 15,
    endX: s(3) * 100,                          // spread outward
    endY: -10 + s(4) * 90,                     // mostly upward bias
    delay: 6 + s(5) * 30,                      // staggered burst
    size: 3 + s(6) * 9,
    lifespan: 30 + s(7) * 25,
    hueShift: s(8) * 15,                       // slight hue variance gold→amber
  };
});

export const KineticNumber: React.FC<KineticNumberProps> = ({
  value,
  suffix = "",
  label = "",
  source = "",
  palette = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const bg = palette.bg ?? "#0F1419";
  const primary = palette.primary ?? "#FFD700";
  const accent = palette.accent ?? "#FFC300";
  const labelColor = palette.label ?? "#FFFFFF";
  const sourceColor = palette.source ?? "#E8D5B7";

  // ── Font responsivo alla lunghezza del valore (fix overflow su numeri lunghi
  //    tipo "20.000" che a 360px escono dallo schermo 1080px). 2026-06-15.
  const vlen = value.replace(/\s/g, "").length;
  const valueFontSize = vlen <= 3 ? 360 : vlen === 4 ? 320 : vlen === 5 ? 270 : vlen === 6 ? 228 : 190;
  const suffixFontSize = Math.round(valueFontSize * 0.56);

  // ───────────── PHASE 1 — IMPACT (frames 0-30) ─────────────
  const impactProgress = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 180, mass: 1 },
  });
  const entranceScale = interpolate(impactProgress, [0, 1], [0.25, 1.1]);
  const motionBlurPx = interpolate(frame, [0, 18, 28], [35, 14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Flash: white burst at impact, settles to gold
  const flashAmount = interpolate(frame, [6, 14, 24], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Impact shake (micro)
  const shakeX = frame < 20 ? Math.sin(frame * 2.3) * (1 - frame / 20) * 6 : 0;
  const shakeY = frame < 20 ? Math.cos(frame * 1.9) * (1 - frame / 20) * 4 : 0;

  // ───────────── PHASE 2 — SETTLE (frames 28-50) ─────────────
  const settleProgress = spring({
    frame: frame - 28,
    fps,
    config: { damping: 16, stiffness: 130, mass: 1 },
  });
  const settleScale = interpolate(settleProgress, [0, 1], [1.1, 1.0]);
  const currentScale = frame < 28 ? entranceScale : settleScale;

  // ───────────── PHASE 3 — CONTEXT REVEAL (frames 32-75) ─────────────
  const suffixProgress = spring({
    frame: frame - 32,
    fps,
    config: { damping: 12, stiffness: 160 },
  });
  const labelProgress = spring({
    frame: frame - 44,
    fps,
    config: { damping: 14, stiffness: 110 },
  });
  const sourceOpacity = interpolate(frame, [58, 75], [0, 0.75], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ───────────── PHASE 4 — BREATH + PARALLAX (frames 60+) ─────────────
  const breath = 1 + Math.sin(Math.max(0, frame - 60) / 14) * 0.013;
  const parallaxY = interpolate(frame, [0, 120], [0, -25]);
  const bgGlow = 0.45 + Math.sin(frame / 18) * 0.2;

  // ───────────── LIGHT SWEEP (frames 78-108) ─────────────
  const sweepLeftPct = interpolate(frame, [78, 110], [-30, 130], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sweepOpacity = interpolate(
    frame,
    [78, 88, 98, 110],
    [0, 0.9, 0.9, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Number color interpolation (flash white → primary gold)
  const numberColor = `rgb(${Math.round(interpolate(flashAmount, [0, 1], [0xFF, 0xFF]))}, ${Math.round(
    interpolate(flashAmount, [0, 1], [0xD7, 0xFF])
  )}, ${Math.round(interpolate(flashAmount, [0, 1], [0x00, 0xFF]))})`;
  const glowStrength = 40 + flashAmount * 80;

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      {/* BACK LAYER — radial glow pulsing + parallax */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse 50% 45% at 50% 52%, rgba(255, 195, 0, ${bgGlow * 0.45}) 0%, rgba(139, 37, 0, ${bgGlow * 0.15}) 40%, transparent 70%)`,
          transform: `translateY(${parallaxY * 0.3}px)`,
        }}
      />

      {/* BACK LAYER 2 — subtle grid / noise texture (vignette gradient) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 50% 50%, transparent 50%, rgba(0,0,0,0.6) 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* MID LAYER — kinetic number + suffix */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${parallaxY}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            transform: `scale(${currentScale * breath}) translate(${shakeX}px, ${shakeY}px)`,
            transformOrigin: "center",
            filter: `blur(${motionBlurPx}px)`,
          }}
        >
          <span
            style={{
              fontFamily: spaceFont,
              fontSize: valueFontSize,
              fontWeight: 900,
              color: numberColor,
              letterSpacing: -10,
              textShadow: `0 0 ${glowStrength}px ${accent}, 0 0 ${glowStrength * 1.8}px rgba(255, 215, 0, 0.35)`,
              lineHeight: 0.85,
            }}
          >
            {value}
          </span>
          {suffix && (
            <span
              style={{
                fontFamily: spaceFont,
                fontSize: suffixFontSize,
                fontWeight: 900,
                color: primary,
                letterSpacing: -4,
                marginLeft: 16,
                transform: `scale(${interpolate(suffixProgress, [0, 1], [0, 1])})`,
                transformOrigin: "bottom left",
                textShadow: `0 0 30px ${accent}`,
                opacity: Math.min(1, Math.max(0, suffixProgress)),
              }}
            >
              {suffix}
            </span>
          )}
        </div>
      </div>

      {/* LABEL */}
      {label && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "26%",
            textAlign: "center",
            opacity: Math.min(1, Math.max(0, labelProgress)),
            transform: `translateY(${interpolate(labelProgress, [0, 1], [35, 0])}px)`,
          }}
        >
          <span
            style={{
              fontFamily: spaceFont,
              fontSize: 68,
              fontWeight: 700,
              color: labelColor,
              letterSpacing: 3,
              textTransform: "uppercase",
              textShadow: "0 2px 20px rgba(0,0,0,0.8)",
            }}
          >
            {label}
          </span>
        </div>
      )}

      {/* SOURCE */}
      {source && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "13%",
            textAlign: "center",
            opacity: sourceOpacity,
          }}
        >
          <span
            style={{
              fontFamily: spaceFont,
              fontSize: 30,
              fontWeight: 400,
              color: sourceColor,
              letterSpacing: 6,
              textTransform: "uppercase",
            }}
          >
            {source}
          </span>
        </div>
      )}

      {/* FRONT LAYER — particles */}
      {PARTICLES.map((p) => {
        const pFrame = Math.max(0, frame - p.delay);
        const pProgress = interpolate(pFrame, [0, p.lifespan], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const x = interpolate(pProgress, [0, 1], [p.startX, p.endX]);
        const y = interpolate(pProgress, [0, 1], [p.startY, p.endY]);
        const opacity = interpolate(
          pFrame,
          [0, 8, p.lifespan * 0.7, p.lifespan],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const hue = 45 - p.hueShift; // 30-45 gold range
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: `hsl(${hue}, 100%, 65%)`,
              boxShadow: `0 0 ${p.size * 2.5}px hsl(${hue}, 100%, 60%), 0 0 ${p.size * 5}px hsl(${hue}, 100%, 55%)`,
              opacity,
              pointerEvents: "none",
            }}
          />
        );
      })}

      {/* LIGHT SWEEP — diagonal white blade across the number */}
      <div
        style={{
          position: "absolute",
          top: "-10%",
          left: `${sweepLeftPct}%`,
          width: "22%",
          height: "120%",
          background: `linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.12) 45%, rgba(255, 215, 0, 0.35) 50%, rgba(255, 255, 255, 0.12) 55%, transparent 100%)`,
          opacity: sweepOpacity,
          transform: "skewX(-18deg)",
          pointerEvents: "none",
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};
