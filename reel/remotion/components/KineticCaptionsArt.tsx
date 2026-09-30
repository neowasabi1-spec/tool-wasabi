import React from "react";
import { useCurrentFrame, Easing, interpolate } from "remotion";
import { measureText } from "@remotion/layout-utils";
import { antonFont } from "../utils/fonts";
import type { SubtitleWord } from "../types";

/**
 * KineticCaptionsArt — sottotitoli kinetic di PRODUZIONE (2026-06-20).
 *
 * Direzione (feedback Michel):
 *  - UN SOLO FONT adatto alla direzione artistica del video (qui video frontale
 *    semplice → Anton). La varietà multi-font è solo da showcase, non da produzione.
 *  - Spaziatura orizzontale ROBUSTA: misura reale di ogni parola (measureText) →
 *    wrapping su righe che stanno SEMPRE dentro i margini. Mai fuori schermo.
 *  - Solo nel 50% inferiore, posizione di lettura stabile e centrata (l'occhio segue).
 *
 * Dinamismo (kinetic) senza caos: gerarchia di dimensione (parola-hero più grande
 * + oro + glow), pop sulla parola pronunciata, parole future fantasma (trasparenza),
 * rise word-by-word. Copertura totale del parlato.
 */

const STOP = new Set([
  "che", "di", "il", "la", "le", "lo", "gli", "i", "un", "una", "uno", "e", "è", "in",
  "a", "da", "per", "con", "su", "del", "della", "dei", "delle", "al", "alla", "ai",
  "ok", "si", "sì", "ah", "eh", "ma", "o", "se", "non", "ci", "ne", "mi", "ti", "c'è",
  "lì", "qua", "qui", "ho", "ha", "hai", "te", "me", "lui", "sé", "io", "questa", "cosa",
]);

const endsSentence = (t: string) => /[.!?:…]$/.test(t.trim());

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

function heroIndex(g: SubtitleWord[]): number {
  let bi = 0;
  let bl = -1;
  g.forEach((w, i) => {
    const clean = w.text.replace(/[^\p{L}']/gu, "");
    const isStop = STOP.has(clean.toLowerCase());
    const len = isStop ? clean.length - 6 : clean.length;
    if (len > bl) {
      bl = len;
      bi = i;
    }
  });
  return bi;
}

const GOLD = "#EBB24A";
const WHITE = "#FFFFFF";

const FRAME_W = 1080;
const SIDE_MARGIN = 80;
const MAX_LINE = FRAME_W - 2 * SIDE_MARGIN; // 920
const LETTER_SPACING = "1px";
const FONT_WEIGHT = 400; // Anton ha solo 400

interface Props {
  words: SubtitleWord[];
  maxWordsPerGroup?: number;
  baseSize?: number;
  heroScale?: number;
  hiddenIntervals?: [number, number][];
  /** Posizione verticale: distanza dal fondo (frazione). Banda bassa di default. */
  bottomPct?: number;
  /** Font UNICO (loaded family). Default Anton. Deve essere un font caricato in
   *  fonts.ts perché measureText lo misuri correttamente. */
  fontFamily?: string;
  fontWeight?: number | string;
  /** Colore parole normali (default bianco). */
  color?: string;
  /** Colore parola-hero / accento (default oro). */
  accentColor?: string;
  strokePx?: number;
}

interface MWord {
  w: SubtitleWord;
  i: number;
  isHero: boolean;
  size: number;
  text: string;
  width: number;
}

export const KineticCaptionsArt: React.FC<Props> = ({
  words,
  maxWordsPerGroup = 4,
  baseSize = 92,
  heroScale = 1.34,
  hiddenIntervals,
  bottomPct = 0.15,
  fontFamily = antonFont,
  fontWeight = FONT_WEIGHT,
  color: baseColor = WHITE,
  accentColor = GOLD,
  strokePx = 3,
}) => {
  const frame = useCurrentFrame();

  if (hiddenIntervals?.some(([s, e]) => frame >= s && frame < e)) return null;
  if (!words || words.length === 0) return null;

  const groups = groupWords(words, maxWordsPerGroup);
  let active: SubtitleWord[] | null = null;
  let groupStart = 0;
  let lastEnd = 0;
  let nextStart = Infinity;
  let displayEnd = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const s0 = g[0].startFrame;
    const le = g[g.length - 1].endFrame;
    const ns = gi + 1 < groups.length ? groups[gi + 1][0].startFrame : Infinity;
    const de = Math.min(ns, le + 45);
    if (frame >= s0 && frame < de) {
      active = g;
      groupStart = s0;
      lastEnd = le;
      nextStart = ns;
      displayEnd = de;
      break;
    }
  }
  if (!active) return null;

  const hero = heroIndex(active);

  const hasPause = nextStart === Infinity || nextStart - lastEnd > 20;
  const fadeIn = interpolate(frame, [groupStart - 1, groupStart + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = hasPause ? interpolate(frame, [displayEnd - 9, displayEnd], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const blockOpacity = Math.min(fadeIn, fadeOut);

  // ── Misura REALE di ogni parola (Anton, uppercase) → larghezza esatta. ──
  const measured: MWord[] = active.map((w, i) => {
    const isHero = i === hero;
    const size = baseSize * (isHero ? heroScale : 1);
    const text = w.text.toUpperCase();
    const { width } = measureText({ text, fontFamily, fontSize: size, fontWeight, letterSpacing: LETTER_SPACING });
    return { w, i, isHero, size, text, width };
  });

  // Scala globale se la parola più larga sfora da sola (parola lunghissima).
  const maxWordW = Math.max(...measured.map((m) => m.width));
  const gScale = Math.min(1, MAX_LINE / maxWordW);
  if (gScale < 1) {
    for (const m of measured) {
      m.size *= gScale;
      m.width *= gScale;
    }
  }

  // Wrapping greedy: righe che stanno SEMPRE entro MAX_LINE (misura reale).
  const gap = 0.16 * baseSize * gScale;
  const lines: MWord[][] = [[]];
  let curW = 0;
  for (const m of measured) {
    const add = (lines[lines.length - 1].length ? gap : 0) + m.width;
    if (lines[lines.length - 1].length && curW + add > MAX_LINE) {
      lines.push([m]);
      curW = m.width;
    } else {
      lines[lines.length - 1].push(m);
      curW += add;
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: `${bottomPct * 100}%`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0,
        opacity: blockOpacity,
      }}
    >
      {lines.map((line, li) => (
        <div
          key={li}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "center",
            gap: `${gap}px`,
            lineHeight: 0.98,
            whiteSpace: "nowrap",
          }}
        >
          {line.map((m) => {
            const w = m.w;
            const isHero = m.isHero;
            const isActive = frame >= w.startFrame && frame <= w.endFrame;
            const isSpoken = frame >= w.startFrame;

            const revealStart = Math.max(groupStart, w.startFrame - 7);
            const rp = interpolate(frame, [revealStart, revealStart + 13], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
            const ty = (1 - rp) * (isHero ? 26 : 34);

            const speakPop = isActive
              ? interpolate(frame, [w.startFrame, w.startFrame + 5, w.startFrame + 15], [1, 1.08, 1.02], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.quad) })
              : 1;

            const color = isHero ? accentColor : baseColor;
            const wordOpacity = isHero ? 1 : isSpoken ? 1 : 0.34;
            const glow = isHero;

            return (
              <span
                key={`${m.text}-${m.i}`}
                style={{
                  fontFamily: `${fontFamily}, "Helvetica Neue", Arial, sans-serif`,
                  fontWeight,
                  fontSize: m.size,
                  textTransform: "uppercase",
                  letterSpacing: LETTER_SPACING,
                  color,
                  display: "inline-block",
                  opacity: rp * wordOpacity,
                  transform: `translateY(${ty}px) scale(${speakPop})`,
                  transformOrigin: "center bottom",
                  WebkitTextStroke: strokePx ? `${strokePx}px #000` : "0",
                  paintOrder: "stroke",
                  textShadow: glow
                    ? `0 0 30px ${accentColor}80, 0 5px 18px rgba(0,0,0,0.8)`
                    : "0 5px 18px rgba(0,0,0,0.82)",
                }}
              >
                {m.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};
