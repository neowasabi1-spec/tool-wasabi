import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { interFont } from "../utils/fonts";

/**
 * Nameplate — targa lower-third da talk show (stile Mediaset 2000s).
 * Usata nei reel "talk show" per etichettare gli ospiti-archetipo
 * ("LA SUA EX SDR", "IL SUO CENTRALINO"...): rende l'allegoria leggibile
 * in 1 secondo, come le targhe dell'ad GHL di riferimento.
 *
 * Posizione: bottom ~16% (top ~78%) — NON collide con i sottotitoli del
 * motore (top 62%) né con la UI social. Font Inter = stesso dei sottotitoli
 * (regola: i componenti grafici matchano il font dei sottotitoli).
 * Resta visibile per tutta la scena: slide-up + settle all'ingresso.
 */
export const Nameplate: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const translateY = interpolate(enter, [0, 1], [40, 0]);
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "16%",
        display: "flex",
        justifyContent: "center",
        opacity,
        transform: `translateY(${translateY}px)`,
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(135deg, rgba(27,20,40,0.92) 0%, rgba(58,18,32,0.92) 100%)",
          border: "2px solid rgba(201,163,107,0.9)",
          borderRadius: 10,
          padding: "14px 34px",
          boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
        }}
      >
        <span
          style={{
            fontFamily: interFont,
            fontWeight: 800,
            fontSize: 44,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: "#E8DCC8",
            textShadow: "0 2px 6px rgba(0,0,0,0.6)",
            whiteSpace: "nowrap",
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
