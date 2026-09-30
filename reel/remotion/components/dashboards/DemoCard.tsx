import React from "react";
import { AbsoluteFill } from "remotion";
import { Reveal, CountUp } from "../../utils/dashboard-motion";
import { interFont } from "../../utils/fonts";

/**
 * DemoCard — esempio didattico del pattern `dashboardComponent`.
 *
 * È il template da copiare quando crei una card per un cliente reale:
 *   1. duplica questo file come <Cliente>Cards.tsx
 *   2. sostituisci PALETTE e testi coi token del BRAND del cliente
 *      (estratti dalla sua landing: hex più citati + font — vedi CLAUDE.md
 *      → "Dashboard animate" per la recipe completa)
 *   3. registra il componente in ./registry.ts con un id kebab-case
 *   4. nello script.json: scena con `dashboardComponent: "<id>"` + voiceoverSegment
 *
 * Regole: animare SEMPRE con le primitive di dashboard-motion (Reveal/CountUp/
 * GrowBar/DonutSweep), mai numeri inventati senza fonte dichiarata, font
 * coerente coi sottotitoli del reel (Inter di default).
 */

const PALETTE = {
  bg: "#101826",
  panel: "#1A2638",
  text: "#F2F5F9",
  accent: "#5BA8FF",
  muted: "#8FA3BD",
};

export const DemoCard: React.FC = () => (
  <AbsoluteFill
    style={{
      background: PALETTE.bg,
      fontFamily: interFont,
      color: PALETTE.text,
      justifyContent: "center",
      alignItems: "center",
      padding: 90,
    }}
  >
    <div
      style={{
        background: PALETTE.panel,
        borderRadius: 36,
        padding: "70px 64px",
        width: "100%",
        textAlign: "center",
      }}
    >
      <Reveal start={2} dur={12}>
        <div style={{ fontSize: 34, letterSpacing: 6, color: PALETTE.muted, textTransform: "uppercase" }}>
          Esempio card
        </div>
      </Reveal>
      <Reveal start={12} dur={14} dy={24}>
        <div style={{ fontSize: 120, fontWeight: 800, lineHeight: 1.05, marginTop: 28, color: PALETTE.accent }}>
          <CountUp target={127} start={16} dur={34} suffix="%" />
        </div>
      </Reveal>
      <Reveal start={30} dur={14}>
        <div style={{ fontSize: 46, fontWeight: 700, marginTop: 24 }}>
          Il numero atterra da solo
        </div>
      </Reveal>
      <Reveal start={44} dur={14}>
        <div style={{ fontSize: 30, color: PALETTE.muted, marginTop: 18, lineHeight: 1.4 }}>
          Reveal staggerato + count-up: la card dimostra il claim
          invece di descriverlo. [ILLUSTRATIVE]
        </div>
      </Reveal>
    </div>
  </AbsoluteFill>
);
