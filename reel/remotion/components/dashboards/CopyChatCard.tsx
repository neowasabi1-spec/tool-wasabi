import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { interFont } from "../../utils/fonts";
import { ramp, useReveal } from "../../utils/dashboard-motion";

/**
 * CopyChatCard — card animata "l'AI scrive il copy": una chat in cui la risposta
 * (un pezzo di copy) appare con effetto TYPING. Full-frame 9:16, animata per
 * costruzione (primitive dashboard-motion). Usala come scena del montaggio con
 *   { "type": "card", "component": "copy-chat-card", "durSec": 4.7 }
 *
 * PERSONALIZZA: cambia il blocco CONFIG qui sotto (brand, colori, testi). Per AVERE
 * PIÙ VARIANTI nello stesso reel, DUPLICA il file con un altro nome + un nuovo id nel
 * registry (i dashboardComponent non prendono props da JSON: il testo è nel file).
 */

// ─── CONFIG — modifica QUI ───────────────────────────────────────────────────
const BRAND = "Il tuo brand"; // nome in alto a sinistra
const SUBTITLE = "scrive il copy"; // riga piccola sotto il brand
const USER_MSG = "Scrivimi l'apertura dell'ad per il mio cliente.";
const REPLY =
  "Hai presente quei video che ti fermano il pollice a metà scroll? Non è fortuna, è struttura. E da oggi la scrivi, e la produci, da solo.";
const INK = "#1F1E1D"; // testo / blocchi scuri
const CREAM = "#F2F1EC"; // sfondo
const ACCENT = "#D97757"; // spark, cursore, tasto invio
// ─────────────────────────────────────────────────────────────────────────────

const PANEL = "#FBFAF7";
const BUBBLE = "#E7E3DA";
const MUTE = "#7C7A73";

const Spark: React.FC<{ size?: number; color?: string }> = ({ size = 40, color = ACCENT }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 2c.5 4.5 2.5 6.5 8 8-5.5 1.5-7.5 3.5-8 8-.5-4.5-2.5-6.5-8-8 5.5-1.5 7.5-3.5 8-8z" fill={color} />
  </svg>
);

export const CopyChatCard: React.FC = () => {
  const frame = useCurrentFrame();
  const header = useReveal(0, 12, 14);
  const userR = useReveal(14, 12, 16);
  const replyStart = 34;
  const typeStart = 46;
  const typeDur = 92;
  const shown = Math.floor(REPLY.length * ramp(frame, typeStart, typeDur));
  const typed = REPLY.slice(0, shown);
  const typing = frame >= typeStart && shown < REPLY.length;
  const preReply = frame >= replyStart && frame < typeStart;
  const cursorOn = Math.floor(frame / 7) % 2 === 0;
  const replyR = useReveal(replyStart, 10, 12);
  const dotO = (i: number) => 0.3 + 0.7 * Math.abs(Math.sin((frame - replyStart) / 6 - i * 0.6));

  return (
    <AbsoluteFill style={{ background: CREAM, fontFamily: interFont }}>
      <div style={{ position: "absolute", inset: 0, padding: "120px 64px 64px", display: "flex", flexDirection: "column" }}>
        <div style={{ ...header, display: "flex", alignItems: "center", gap: 18, marginBottom: 56 }}>
          <div style={{ width: 64, height: 64, borderRadius: 18, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Spark size={36} color={CREAM} />
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 38, fontWeight: 800, color: INK, letterSpacing: -0.5 }}>{BRAND}</span>
            <span style={{ fontSize: 24, fontWeight: 500, color: MUTE }}>{SUBTITLE}</span>
          </div>
        </div>

        <div style={{ ...userR, display: "flex", justifyContent: "flex-end", marginBottom: 40 }}>
          <div style={{ maxWidth: "82%", background: BUBBLE, color: INK, fontSize: 44, lineHeight: 1.32, fontWeight: 500, padding: "28px 34px", borderRadius: "28px 28px 8px 28px" }}>
            {USER_MSG}
          </div>
        </div>

        <div style={{ ...replyR, display: "flex", gap: 22, alignItems: "flex-start" }}>
          <div style={{ flexShrink: 0, marginTop: 6 }}>
            <Spark size={48} color={ACCENT} />
          </div>
          <div style={{ flex: 1 }}>
            {preReply ? (
              <div style={{ display: "flex", gap: 12, paddingTop: 14 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ width: 18, height: 18, borderRadius: 9, background: MUTE, opacity: dotO(i) }} />
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 48, lineHeight: 1.4, fontWeight: 500, color: INK }}>
                {typed}
                {typing && <span style={{ color: ACCENT, opacity: cursorOn ? 1 : 0, fontWeight: 700 }}>▍</span>}
              </span>
            )}
          </div>
        </div>

        <div style={{ marginTop: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, background: PANEL, border: `2px solid ${BUBBLE}`, borderRadius: 28, padding: "26px 28px" }}>
            <span style={{ flex: 1, fontSize: 34, color: MUTE, fontWeight: 500 }}>Rispondi a {BRAND}...</span>
            <div style={{ width: 60, height: 60, borderRadius: 16, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width={30} height={30} viewBox="0 0 24 24" fill="none">
                <path d="M12 20V6M12 6l-6 6M12 6l6 6" stroke={CREAM} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
