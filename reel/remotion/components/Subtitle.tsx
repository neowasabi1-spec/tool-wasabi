import React from "react";
import { useCurrentFrame } from "remotion";
import { interFont } from "../utils/fonts";
import type { SubtitleWord } from "../types";

interface SubtitleProps {
  words: SubtitleWord[];
  fontSize?: number;
  color?: string;
  highlightColor?: string;
  backgroundColor?: string;
  position?: "bottom" | "center" | "safe-zone";
  maxWordsPerGroup?: number;
  /** Override font (default Inter). Es. "GT Super Display Bold" per look serif. */
  fontFamily?: string;
  fontWeight?: number | string;
  /** Spessore outline nero attorno al testo (px). Default 6 — con paint-order
   *  stroke (dietro il fill) il bordo VISIBILE è ~metà. */
  strokePx?: number;
  strokeColor?: string;
  /** Intervalli di frame [start,end) in cui il sottotitolo NON deve apparire
   *  (es. scene dashboard/card full-frame che mostrano già il testo). Gating per
   *  frame: una parola di confine resta visibile sulla scena video adiacente ma
   *  sparisce mentre la card è a schermo (no overlap, no parole mangiate). */
  hiddenIntervals?: [number, number][];
}

export const Subtitle: React.FC<SubtitleProps> = ({
  words,
  fontSize = 72,
  color = "#FFFFFF",
  highlightColor = "#C9A36B",
  backgroundColor = "transparent",
  position = "safe-zone",
  maxWordsPerGroup = 5,
  hiddenIntervals,
  fontFamily,
  fontWeight = 800,
  strokePx = 6,
  strokeColor = "#000",
}) => {
  const frame = useCurrentFrame();

  // Nascondi del tutto il sottotitolo mentre è a schermo una card/dashboard.
  if (hiddenIntervals?.some(([s, e]) => frame >= s && frame < e)) return null;

  // Find the group of consecutive words that are active (chunked for readability)
  const currentGroup = findCurrentGroup(words, frame, maxWordsPerGroup);

  if (currentGroup.length === 0) return null;

  // safe-zone = ~70% from top — sotto la descrizione (top UI) e sopra i bottoni UX (bottom UI)
  // di TikTok/Reels/Shorts, mai coperto dalla caption. (Abbassato da 62% a 70% su richiesta — reel DIY VideoClaude.)
  const verticalStyle =
    position === "center"
      ? { top: "50%", transform: "translateY(-50%)" }
      : position === "bottom"
        ? { bottom: 200 }
        : { top: "70%", transform: "translateY(-50%)" };

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        ...verticalStyle,
        display: "flex",
        justifyContent: "center",
        padding: "0 80px",
      }}
    >
      <div
        style={{
          backgroundColor,
          borderRadius: 12,
          padding: backgroundColor === "transparent" ? 0 : "16px 28px",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "14px",
          maxWidth: 920,
        }}
      >
        {currentGroup.map((word, i) => {
          const isActive = frame >= word.startFrame && frame <= word.endFrame;
          return (
            <span
              key={`${word.text}-${i}`}
              style={{
                fontSize,
                // Fallback di sistema in coda: se il font primario non ha un
                // glifo (es. accentata a peso 800), il browser usa Arial invece
                // di disegnare un quadratino notdef.
                fontFamily: `${fontFamily ?? interFont}, "Helvetica Neue", Arial, sans-serif`,
                fontWeight,
                letterSpacing: 0.5,
                lineHeight: 1.18,
                color: isActive ? highlightColor : color,
                // Outline pulito: stroke spesso solido renderizzato DIETRO il
                // fill (paint-order: stroke) → bordo uniforme, niente "bordi
                // netti neri" blocky del WebkitTextStroke dipinto sopra il fill
                // (che si mangiava le aste sottili). Una sola ombra MORBIDA per
                // lo stacco su sfondi chiari, senza bordi duri.
                WebkitTextStroke: `${strokePx}px ${strokeColor}`,
                paintOrder: "stroke",
                textShadow: "0 3px 12px rgba(0,0,0,0.55)",
                transition: "color 0.08s",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

function findCurrentGroup(
  words: SubtitleWord[],
  frame: number,
  maxWordsPerGroup: number = 5
): SubtitleWord[] {
  // Group words by proximity (within 15 frames) and forced split every N words.
  // Forced split = leggibilità: in 9:16 max ~5 parole per pillola, oltre il viewer
  // legge a metà mentre la parola attiva è già passata.
  const groups: SubtitleWord[][] = [];
  let currentGroup: SubtitleWord[] = [];

  // Una parola che chiude una frase (.!?:…) forza la fine del gruppo: la frase
  // successiva NON deve mai comparire insieme alla precedente (anticiperebbe il
  // punchline). Feedback Michel 2026-06-09.
  const endsSentence = (w: SubtitleWord) =>
    [".", "!", "?", ":", "…"].includes(w.text.trim().slice(-1));

  for (const word of words) {
    const prev = currentGroup[currentGroup.length - 1];
    const tooFar =
      currentGroup.length > 0 && word.startFrame - prev.endFrame >= 15;
    const tooLong = currentGroup.length >= maxWordsPerGroup;
    const prevEndsSentence = prev != null && endsSentence(prev);
    if (currentGroup.length === 0 || (!tooFar && !tooLong && !prevEndsSentence)) {
      currentGroup.push(word);
    } else {
      groups.push(currentGroup);
      currentGroup = [word];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Find group that contains current frame
  for (const group of groups) {
    const groupStart = group[0].startFrame;
    const groupEnd = group[group.length - 1].endFrame;
    // Nessun pre-roll (la frase non appare prima d'essere parlata; il lead di
    // sync è già nei startFrame via leadSec). Post-roll breve per leggibilità.
    if (frame >= groupStart && frame <= groupEnd + 5) {
      return group;
    }
  }

  return [];
}
