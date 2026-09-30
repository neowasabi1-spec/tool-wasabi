import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { KineticCaptionsArt } from "../components/KineticCaptionsArt";

/**
 * DEMO standalone dei sottotitoli kinetic variant "motion" (KineticCaptionsArt).
 * Font unico Anton, banda bassa centrata, parola-hero oro+glow, parole future
 * fantasma, larghezza robusta via measureText. Self-contained: nessun asset.
 *
 * Per vederla in Remotion Studio aggiungi questa riga in remotion/Root.tsx, tra
 * le altre <Composition ...> (l'import in cima: `import { KineticCaptionsMotionDemo }
 * from "./compositions/KineticCaptionsMotionDemo";`):
 *
 *   <Composition id="KineticCaptionsMotionDemo" component={KineticCaptionsMotionDemo}
 *     durationInFrames={200} fps={30} width={1080} height={1920} />
 */

const DEMO_CAPTION_WORDS = [
  { text: "il", startFrame: 6, endFrame: 18 },
  { text: "sistema", startFrame: 18, endFrame: 42 },
  { text: "dei", startFrame: 42, endFrame: 54 },
  { text: "sottotitoli", startFrame: 54, endFrame: 84 },
  { text: "dinamici", startFrame: 84, endFrame: 110 },
  { text: "ora", startFrame: 116, endFrame: 130 },
  { text: "funziona", startFrame: 130, endFrame: 156 },
  { text: "in", startFrame: 156, endFrame: 164 },
  { text: "produzione", startFrame: 164, endFrame: 192 },
];

/** Sfondo "footage" finto: gradiente che respira lentamente (zero asset). */
const FakeFootage: React.FC = () => {
  const frame = useCurrentFrame();
  const shift = interpolate(frame, [0, 200], [0, 40]);
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${135 + shift}deg, #14223b 0%, #2a3550 55%, #0d1320 100%)`,
      }}
    />
  );
};

export const KineticCaptionsMotionDemo: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <FakeFootage />
    <KineticCaptionsArt words={DEMO_CAPTION_WORDS} />
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        paddingTop: 80,
      }}
    >
      <div
        style={{
          fontFamily: "monospace",
          fontSize: 28,
          color: "rgba(255,255,255,0.55)",
          letterSpacing: 1,
        }}
      >
        subtitleStyle.variant: motion · Anton
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
