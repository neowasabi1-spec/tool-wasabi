import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadArchivo } from "@remotion/google-fonts/ArchivoBlack";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import type { TypoSceneData, TypoLine } from "../../src/schemas/typo-schema";

/**
 * TypoScene — scene TIPOGRAFICHE parametriche (add-on "Tipografia Cinetica").
 * Renderizza testo animato ad alto contrasto a COSTO ZERO API (componente
 * Remotion puro). 4 modi: lines / flip / repeat / counter. Configurabile via il
 * campo `typo` dello script.json. Si mescola liberamente con scene video-AI nello
 * stesso reel (ogni scena è indipendente). Deterministico (no Date/Math.random).
 */

const { fontFamily: anton } = loadAnton();
const { fontFamily: archivo } = loadArchivo();
const { fontFamily: inter } = loadInter("normal", { weights: ["400", "800"], subsets: ["latin", "latin-ext"] });

const PAL = { light: "#F2EFE8", dark: "#0E0C0B", ink: "#14110E", cream: "#F2EFE8", accent: "#D97757" };
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const fontOf = (f?: string) => (f === "anton" ? anton : f === "inter" ? inter : archivo);

const useReveal = (appear: number, mode: string, dur = 6) => {
  const frame = useCurrentFrame();
  const p = clamp01((frame - appear) / dur);
  if (mode === "fade") return { opacity: p } as React.CSSProperties;
  if (mode === "rise") return { opacity: p, transform: `translateY(${(1 - p) * 44}px)` } as React.CSSProperties;
  return { opacity: p > 0 ? 1 : 0, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` } as React.CSSProperties;
};

const Line: React.FC<{ line: TypoLine; appear: number; reveal: string; accent: string; onDark: boolean }> = ({ line, appear, reveal, accent, onDark }) => {
  const r = useReveal(appear, reveal);
  const base = onDark ? PAL.cream : PAL.ink;
  return (
    <div style={{ fontFamily: fontOf(line.font), fontSize: line.size ?? 150, fontWeight: line.weight ?? 800, color: line.accent ? accent : base, textTransform: "uppercase", lineHeight: 0.95, letterSpacing: -1, ...r }}>
      {line.t}
    </div>
  );
};

const Kicker: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const op = clamp01(frame / 8);
  const w = interpolate(frame, [0, 14], [0, 60], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, opacity: op, marginBottom: 18 }}>
      <div style={{ width: w, height: 2, background: accent }} />
      <span style={{ fontFamily: inter, fontSize: 26, fontWeight: 800, letterSpacing: 8, color: accent, textTransform: "uppercase" }}>{text}</span>
      <div style={{ width: w, height: 2, background: accent }} />
    </div>
  );
};

// ripetizione tipografica (texture)
const Tiled: React.FC<{ word: string; onDark: boolean; accent: string; stagger: number }> = ({ word, onDark, accent, stagger }) => {
  const frame = useCurrentFrame();
  const { height: H } = useVideoConfig();
  const rows = 9;
  const rowH = H / rows;
  const base = onDark ? PAL.cream : PAL.ink;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {Array.from({ length: rows }, (_, i) => {
        const appear = i * 3;
        const p = clamp01((frame - appear) / 4);
        const isAccent = i === 4;
        const isOutline = i % 2 === 1 && !isAccent;
        const drift = (i % 2 === 0 ? 1 : -1) * interpolate(frame - appear, [0, 60], [0, 24], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const color = isAccent ? accent : (onDark ? ["#9C968C", "#6E675E", "#403B35"][i % 3] : ["#B8B2A8", "#8E887C", "#C9C3B8"][i % 3]);
        return (
          <div key={i} style={{ position: "absolute", top: i * rowH, left: 0, right: 0, height: rowH, display: "flex", alignItems: "center", justifyContent: "center", transform: `translateX(${drift}px)`, opacity: p > 0 ? 1 : 0, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }}>
            <span style={{ fontFamily: anton, fontSize: rowH * 1.04, lineHeight: 1, letterSpacing: 2, whiteSpace: "nowrap", textTransform: "uppercase", color: isOutline ? "transparent" : color, WebkitTextStroke: isOutline ? `2px ${base}` : undefined, opacity: isOutline ? 0.5 : 1 }}>
              {word} {word} {word}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const TypoScene: React.FC<{ data: TypoSceneData }> = ({ data }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: D, width: W } = useVideoConfig();
  const accent = data.accent ?? PAL.accent;
  const reveal = data.reveal ?? "wipe";
  const stagger = data.stagger ?? 8;
  const outFade = interpolate(frame, [D - 8, D], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // ── FLIP ──
  if (data.mode === "flip") {
    const flip = Math.round((data.flipAt ?? 0.45) * D);
    const phaseB = frame >= flip;
    const rows = phaseB ? (data.phaseB ?? []) : (data.phaseA ?? []);
    return (
      <AbsoluteFill style={{ background: phaseB ? PAL.dark : PAL.light, opacity: outFade, alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        {!phaseB && data.kicker && <Kicker text={data.kicker} accent={accent} />}
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          {rows.map((ln, i) => <Line key={i} line={ln} appear={(phaseB ? flip : 0) + i * stagger} reveal={reveal} accent={accent} onDark={phaseB} />)}
        </div>
      </AbsoluteFill>
    );
  }

  // ── REPEAT ──
  if (data.mode === "repeat") {
    const onDark = (data.bg ?? "dark") === "dark";
    return (
      <AbsoluteFill style={{ background: onDark ? PAL.dark : PAL.light, opacity: outFade }}>
        {data.repeatWord && <Tiled word={data.repeatWord} onDark={onDark} accent={accent} stagger={stagger} />}
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: onDark ? PAL.dark : PAL.light, padding: "28px 40px", textAlign: "center", boxShadow: `0 0 90px 70px ${onDark ? PAL.dark : PAL.light}`, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            {(data.centerLines ?? []).map((ln, i) => <Line key={i} line={ln} appear={Math.round((data.flipAt ?? 0.3) * D) + i * stagger} reveal={reveal} accent={accent} onDark={onDark} />)}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // ── COUNTER ──
  if (data.mode === "counter") {
    const onDark = (data.bg ?? "light") === "dark";
    const from = data.from ?? 0, to = data.to ?? 0;
    const start = stagger, dur = 12;
    const cp = clamp01(interpolate(frame, [start, start + dur], [0, 1], { easing: Easing.out(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    const num = Math.round(from + (to - from) * cp);
    const labW = useReveal(start, reveal);
    return (
      <AbsoluteFill style={{ background: onDark ? PAL.dark : PAL.light, opacity: outFade, alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", textAlign: "center" }}>
          <div style={{ position: "absolute", inset: 0, transform: "translate(15px,13px)", fontFamily: archivo, fontSize: 470, lineHeight: 0.9, letterSpacing: -8, color: "transparent", WebkitTextStroke: `2px ${accent}`, opacity: cp * 0.5 }}>{num}</div>
          <div style={{ position: "relative", fontFamily: archivo, fontSize: 470, lineHeight: 0.9, letterSpacing: -8, color: onDark ? PAL.cream : PAL.ink }}>{num}</div>
        </div>
        <div style={{ width: W * 0.5, height: 9, background: onDark ? "rgba(242,239,232,0.14)" : "rgba(20,17,14,0.12)", marginTop: 28, ...labW }}>
          <div style={{ width: `${cp * 100}%`, height: "100%", background: accent }} />
        </div>
        {data.label && <div style={{ marginTop: 30, fontFamily: inter, fontSize: 58, fontWeight: 800, letterSpacing: 5, color: onDark ? PAL.cream : PAL.ink, textTransform: "uppercase", ...labW }}>{data.label}</div>}
        {data.sublabel && <div style={{ marginTop: 12, fontFamily: inter, fontSize: 30, fontWeight: 700, letterSpacing: 6, color: accent, textTransform: "uppercase", ...labW }}>{data.sublabel}</div>}
      </AbsoluteFill>
    );
  }

  // ── LINES (default) ──
  const onDark = (data.bg ?? "dark") === "dark";
  return (
    <AbsoluteFill style={{ background: onDark ? PAL.dark : PAL.light, opacity: outFade, alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
      {data.kicker && <Kicker text={data.kicker} accent={accent} />}
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        {(data.lines ?? []).map((ln, i) => <Line key={i} line={ln} appear={i * stagger} reveal={reveal} accent={accent} onDark={onDark} />)}
      </div>
    </AbsoluteFill>
  );
};
