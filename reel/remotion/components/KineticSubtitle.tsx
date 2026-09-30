import React from "react";
import { useCurrentFrame, Easing, interpolate } from "remotion";
import { interFont } from "../utils/fonts";
import type { SubtitleWord } from "../types";

/**
 * KineticSubtitle — sottotitoli kinetic a COPERTURA TOTALE del parlato (voto
 * Michel 9/10, 2026-06-20). Versione di produzione di KineticCaptions, frame-based
 * e drop-in per `Subtitle` (stessa shape `SubtitleWord[]` + hiddenIntervals).
 *
 * Look: blocchi di ~4 parole, ogni parola SALE dal basso (translateY + opacity,
 * ease cubic, sovrapposto tra parole = onda fluida — tecnica AE Range Selector
 * "Ramp Up"), parola attiva in oro. Layout STABILE (tutte le parole del blocco
 * renderizzate in posizione, solo opacity/transform animati → niente reflow).
 *
 * Attivato in BasicReel da `subtitleStyle.kinetic: true`.
 */

interface KineticSubtitleProps {
  words: SubtitleWord[];
  fontSize?: number;
  color?: string;
  highlightColor?: string;
  position?: "bottom" | "center" | "safe-zone";
  maxWordsPerGroup?: number;
  fontFamily?: string;
  fontWeight?: number | string;
  strokePx?: number;
  strokeColor?: string;
  /** Intervalli di frame in cui il sottotitolo NON deve apparire (card/typo full-frame). */
  hiddenIntervals?: [number, number][];
  /** Distanza verticale del rise (px). */
  risePx?: number;
  /** Griglia beat (frame) della musica. Se presente (contenuto music-driven),
   *  ogni parola entra agganciata al beat più vicino ≤ il suo onset di voce
   *  invece che ai word-timestamps puri → reveal a tempo di musica. */
  beats?: number[];
}

/** Beat più grande ≤ frame (la voce è già on-beat → quantizza il reveal al beat). */
function snapToBeat(frame: number, beats: number[]): number {
  let best = -Infinity;
  for (const b of beats) if (b <= frame && b > best) best = b;
  return best === -Infinity ? frame : best;
}

const endsSentence = (t: string) => /[.!?:…]$/.test(t.trim());

/** Raggruppa in blocchi leggibili: ≤maxPerGroup, break su pausa (≥15 frame) o fine frase. */
function groupWords(words: SubtitleWord[], maxPerGroup: number): SubtitleWord[][] {
  const groups: SubtitleWord[][] = [];
  let cur: SubtitleWord[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const tooFar = prev != null && w.startFrame - prev.endFrame >= 15;
    const tooLong = cur.length >= maxPerGroup;
    const prevEnds = prev != null && endsSentence(prev.text);
    if (cur.length === 0 || (!tooFar && !tooLong && !prevEnds)) cur.push(w);
    else {
      groups.push(cur);
      cur = [w];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export const KineticSubtitle: React.FC<KineticSubtitleProps> = ({
  words,
  fontSize = 74,
  color = "#FFFFFF",
  highlightColor = "#EBB24A",
  position = "safe-zone",
  maxWordsPerGroup = 4,
  fontFamily,
  fontWeight = 800,
  strokePx = 6,
  strokeColor = "#000",
  hiddenIntervals,
  risePx = 52,
  beats,
}) => {
  const frame = useCurrentFrame();
  const beatSync = beats != null && beats.length > 0;

  if (hiddenIntervals?.some(([s, e]) => frame >= s && frame < e)) return null;
  if (!words || words.length === 0) return null;

  const groups = groupWords(words, maxWordsPerGroup);
  let active: SubtitleWord[] | null = null;
  let groupStart = 0;
  for (const g of groups) {
    const s0 = g[0].startFrame;
    const e0 = g[g.length - 1].endFrame + 8;
    if (frame >= s0 && frame <= e0) {
      active = g;
      groupStart = s0;
      break;
    }
  }
  if (!active) return null;

  const verticalStyle: React.CSSProperties =
    position === "center"
      ? { top: "50%", transform: "translateY(-50%)" }
      : position === "bottom"
        ? { bottom: 200 }
        : { top: "72%", transform: "translateY(-50%)" };

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        ...verticalStyle,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: "12px 26px",
          maxWidth: 920,
          padding: "0 60px",
        }}
      >
        {active.map((w, i) => {
          const isActive = frame >= w.startFrame && frame <= w.endFrame;
          // Voice-driven: reveal ai word-timestamps. Music-driven (beats): il
          // reveal si aggancia al beat ≤ onset → entrata a tempo di musica.
          const revealStart = beatSync
            ? snapToBeat(w.startFrame, beats!)
            : Math.max(groupStart, w.startFrame - 3);
          const rp = interpolate(frame, [revealStart, revealStart + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
          const ty = (1 - rp) * risePx;
          return (
            <span
              key={`${w.text}-${i}`}
              style={{
                fontFamily: `${fontFamily ?? interFont}, "Helvetica Neue", Arial, sans-serif`,
                fontWeight,
                fontSize,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                lineHeight: 1.12,
                color: isActive ? highlightColor : color,
                display: "inline-block",
                opacity: rp,
                transform: `translateY(${ty}px)`,
                WebkitTextStroke: `${strokePx}px ${strokeColor}`,
                paintOrder: "stroke",
                textShadow: isActive
                  ? `0 0 26px ${highlightColor}66, 0 3px 14px rgba(0,0,0,0.85)`
                  : "0 3px 14px rgba(0,0,0,0.9)",
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};
