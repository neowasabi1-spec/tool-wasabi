import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";
import { AnimatedText } from "../components/AnimatedText";
import { BackgroundImage } from "../components/BackgroundImage";
import { KineticNumber } from "../components/KineticNumber";
import { KineticDashboard } from "../components/KineticDashboard";
import { getDashboardComponent } from "../components/dashboards/registry";
import { TypoScene } from "../components/TypoScene";
import { Subtitle } from "../components/Subtitle";
import { KineticSubtitle } from "../components/KineticSubtitle";
import { KineticCaptionsArt } from "../components/KineticCaptionsArt";
import { Nameplate } from "../components/Nameplate";
import { bebasFont, spaceFont, antonFont, oswaldFont, archivoBlackFont, interFont } from "../utils/fonts";
import type { BasicReelProps } from "../types";

/** Mappa captionFont (script) → font caricato + peso, per la variant "motion".
 *  Solo font caricati in fonts.ts (measureText li misura solo se caricati). */
const CAPTION_FONTS: Record<string, { family: string; weight: number }> = {
  anton: { family: antonFont, weight: 400 },
  oswald: { family: oswaldFont, weight: 700 },
  bebas: { family: bebasFont, weight: 400 },
  archivo: { family: archivoBlackFont, weight: 400 },
  inter: { family: interFont, weight: 800 },
};

// Hard cuts (no crossfade) per evitare percezione di "ritardo audio".
// Le sfumature rallentavano l'inizio della scena successiva mentre l'audio
// procedeva in tempo, dando l'illusione di desync. Feedback utente 2026-04-07.
const CROSSFADE_FRAMES = 0;

/** Fade in/out wrapper for scenes (no-op se CROSSFADE_FRAMES === 0 → hard cut) */
const SceneFade: React.FC<{
  children: React.ReactNode;
  durationInFrames: number;
}> = ({ children, durationInFrames }) => {
  const frame = useCurrentFrame();

  if (CROSSFADE_FRAMES <= 0) {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }

  const fadeIn = interpolate(frame, [0, CROSSFADE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const fadeOut = interpolate(
    frame,
    [durationInFrames - CROSSFADE_FRAMES, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      {children}
    </AbsoluteFill>
  );
};

/** Dashboard BI/CRM animata bespoke, risolta per id dal registry e montata full-frame. */
const DashboardComponentScene: React.FC<{ id: string }> = ({ id }) => {
  const Comp = getDashboardComponent(id);
  if (!Comp) {
    return (
      <AbsoluteFill style={{ background: "#0E1116", justifyContent: "center", alignItems: "center" }}>
        <span style={{ color: "#C9534F", fontSize: 40, fontFamily: "monospace", textAlign: "center", padding: 60 }}>
          dashboardComponent "{id}" non registrato in remotion/components/dashboards/registry.ts
        </span>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <Comp />
    </AbsoluteFill>
  );
};

/** Accent line under text */
const AccentLine: React.FC<{ delay?: number; color?: string }> = ({
  delay = 10,
  color = "#FFD700",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { mass: 1, stiffness: 120, damping: 14 },
  });

  return (
    <div
      style={{
        width: interpolate(progress, [0, 1], [0, 120]),
        height: 4,
        backgroundColor: color,
        borderRadius: 2,
        marginTop: 20,
        alignSelf: "center",
        opacity: progress,
      }}
    />
  );
};

export const BasicReel: React.FC<BasicReelProps> = ({
  hook,
  scenes,
  cta,
  voiceoverUrl,
  musicUrl,
  subtitles,
  subtitleStyle,
  musicBeats,
}) => {
  const { fps, durationInFrames: totalFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const hasHook = hook.trim() !== "";
  const hasCta = cta.trim() !== "";
  const hookDuration = hasHook ? Math.round(fps * 2.5) : 0;
  const ctaDuration = hasCta ? Math.round(fps * 2.5) : 0;

  // REGOLA SPAZIO: dashboard/card full-frame e sottotitoli non occupano le
  // stesse zone. Le scene dashboardComponent mostrano già il loro testo a tutto
  // schermo → durante quegli intervalli i sottotitoli vengono soppressi (i word
  // che cadono dentro una scena card sono filtrati via).
  const dashboardIntervals: [number, number][] = [];
  {
    let acc = hasHook ? hookDuration - CROSSFADE_FRAMES : 0;
    for (const s of scenes) {
      // Sopprimi il sottotitolo globale sia sulle card (mostrano già il testo)
      // sia sugli spezzoni splice con caption impresse (hideSubtitle), sia sulle
      // scene KINETIC (KineticNumber/KineticDashboard hanno la loro label full-frame
      // → il sottotitolo VO si sovrapporrebbe al numero) → niente doppia caption.
      if (s.dashboardComponent || s.hideSubtitle || s.kinetic || s.kineticDashboard)
        dashboardIntervals.push([acc, acc + s.durationInFrames]);
      acc += s.durationInFrames - CROSSFADE_FRAMES;
    }
  }
  // I sottotitoli vengono nascosti (gating per FRAME, vedi Subtitle.hiddenIntervals)
  // solo mentre una card è a schermo: le parole di confine restano visibili sulle
  // scene video adiacenti e spariscono solo sopra la card.

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* ─── HOOK ─── */}
      {hook.trim() !== "" && (
        <Sequence from={0} durationInFrames={hookDuration}>
          <SceneFade durationInFrames={hookDuration}>
            <AbsoluteFill
              style={{
                justifyContent: "center",
                alignItems: "center",
                background:
                  "radial-gradient(ellipse at center, #1a1a2e 0%, #0a0a14 100%)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0,
                }}
              >
                <AnimatedText
                  text={hook}
                  animation="wordByWord"
                  fontSize={68}
                  fontFamily={spaceFont}
                  fontWeight="800"
                  preset="punchy"
                  uppercase
                  letterSpacing={2}
                  textShadow="0 0 40px rgba(255,215,0,0.3), 0 4px 20px rgba(0,0,0,0.8)"
                />
                <AccentLine delay={15} />
              </div>
            </AbsoluteFill>
          </SceneFade>
        </Sequence>
      )}

      {/* ─── SCENES ─── */}
      {scenes.map((scene, i) => {
        const hookOffset = hasHook ? hookDuration - CROSSFADE_FRAMES : 0;
        const sceneStart =
          hookOffset +
          scenes
            .slice(0, i)
            .reduce(
              (sum, s) => sum + s.durationInFrames - CROSSFADE_FRAMES,
              0
            );

        return (
          <Sequence
            key={i}
            from={sceneStart}
            durationInFrames={scene.durationInFrames}
          >
            <SceneFade durationInFrames={scene.durationInFrames}>
              {scene.typo ? (
                <TypoScene data={scene.typo} />
              ) : scene.dashboardComponent ? (
                <DashboardComponentScene id={scene.dashboardComponent} />
              ) : scene.kineticDashboard ? (
                <KineticDashboard
                  panels={scene.kineticDashboard.panels}
                  palette={scene.kineticDashboard.palette}
                />
              ) : scene.kinetic ? (
                <KineticNumber
                  value={scene.kinetic.value}
                  suffix={scene.kinetic.suffix}
                  label={scene.kinetic.label}
                  source={scene.kinetic.source}
                  palette={scene.kinetic.palette}
                />
              ) : (
              <AbsoluteFill>
                {/* Video background. Audio:
                    - Se c'è un voiceoverUrl globale → mute i singoli clip
                      (audio gestito dal voiceover separato, modalità ElevenLabs)
                    - Se NON c'è voiceoverUrl → suona l'audio nativo dei clip
                      (modalità Veo 3 / Sora con audio embedded nel video) */}
                {scene.videoUrl ? (
                  <OffthreadVideo
                    src={scene.videoUrl}
                    volume={voiceoverUrl ? 0 : 1}
                    style={{
                      position: "absolute",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : scene.imageUrl ? (
                  <BackgroundImage src={scene.imageUrl} kenBurns zoomRange={scene.kenBurnsRange} />
                ) : (
                  <AbsoluteFill
                    style={{
                      background: `radial-gradient(ellipse at center, hsl(${220 + i * 30}, 40%, 18%) 0%, hsl(${220 + i * 30}, 50%, 6%) 100%)`,
                    }}
                  />
                )}

                {/* Gradient overlay — darker at bottom for text area */}
                <AbsoluteFill
                  style={{
                    background:
                      "linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.2) 40%, rgba(0,0,0,0.65) 100%)",
                  }}
                />

                {/* Nameplate talk-show (targa ospite, lower-third).
                    Con nameplateWindow la targa vive solo nel tratto [from,to]
                    della scena (riprese multi-personaggio con camera move). */}
                {scene.nameplate &&
                  (scene.nameplateWindow ? (
                    <Sequence
                      from={Math.round(scene.nameplateWindow[0] * 30)}
                      durationInFrames={Math.max(
                        1,
                        Math.round(
                          (scene.nameplateWindow[1] - scene.nameplateWindow[0]) * 30
                        )
                      )}
                    >
                      <Nameplate text={scene.nameplate} />
                    </Sequence>
                  ) : (
                    <Nameplate text={scene.nameplate} />
                  ))}

                {/* Text centered, large */}
                {scene.text.trim() !== "" && (
                  <AbsoluteFill
                    style={{
                      justifyContent: "center",
                      alignItems: "center",
                      paddingLeft: 60,
                      paddingRight: 60,
                    }}
                  >
                    <AnimatedText
                      text={scene.text}
                      animation="wordByWord"
                      fontSize={92}
                      fontFamily={spaceFont}
                      fontWeight="800"
                      delay={8}
                      preset="gentle"
                      uppercase
                      letterSpacing={2}
                    />
                  </AbsoluteFill>
                )}
              </AbsoluteFill>
              )}
            </SceneFade>
          </Sequence>
        );
      })}

      {/* ─── CTA ─── */}
      {hasCta &&
        (() => {
          const hookOffset = hasHook ? hookDuration - CROSSFADE_FRAMES : 0;
          const ctaStart =
            hookOffset +
            scenes.reduce(
              (sum, s) => sum + s.durationInFrames - CROSSFADE_FRAMES,
              0
            );
          return (
            <Sequence from={ctaStart} durationInFrames={ctaDuration}>
              <SceneFade durationInFrames={ctaDuration}>
                <AbsoluteFill
                  style={{
                    justifyContent: "center",
                    alignItems: "center",
                    background:
                      "radial-gradient(ellipse at center, #1a0a2e 0%, #0a0a14 100%)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }}
                  >
                    <AnimatedText
                      text={cta}
                      animation="scaleIn"
                      fontSize={60}
                      fontFamily={spaceFont}
                      fontWeight="800"
                      preset="bouncy"
                      color="#FFD700"
                      uppercase
                      letterSpacing={2}
                      textShadow="0 0 50px rgba(255,215,0,0.4), 0 4px 20px rgba(0,0,0,0.8)"
                    />
                    <AccentLine delay={12} color="#FFD700" />
                  </div>
                </AbsoluteFill>
              </SceneFade>
            </Sequence>
          );
        })()}

      {/* ─── SUBTITLES (globale; nascosti per-frame sulle scene card) ─── */}
      {/* Dispatch a tre vie:
          - kinetic + variant "motion" → KineticCaptionsArt (motion typography di
            produzione: 1 font, hero oro+glow, banda bassa centrata, measureText)
          - kinetic (default/variant "rise") → KineticSubtitle (rise 9/10, safe-zone)
          - altrimenti → Subtitle (karaoke piatto, default storico). */}
      {subtitles && subtitles.length > 0 && (
        subtitleStyle?.kinetic && subtitleStyle?.variant === "motion" ? (
          <KineticCaptionsArt
            words={subtitles}
            hiddenIntervals={dashboardIntervals}
            fontFamily={CAPTION_FONTS[subtitleStyle?.captionFont ?? "anton"].family}
            fontWeight={CAPTION_FONTS[subtitleStyle?.captionFont ?? "anton"].weight}
            color={subtitleStyle?.color ?? "#FFFFFF"}
            accentColor={subtitleStyle?.highlightColor ?? "#EBB24A"}
            strokePx={subtitleStyle?.strokePx ?? 3}
            baseSize={subtitleStyle?.baseSize}
            heroScale={subtitleStyle?.heroScale}
            bottomPct={subtitleStyle?.bottomPct}
            maxWordsPerGroup={subtitleStyle?.maxWordsPerGroup}
          />
        ) : subtitleStyle?.kinetic ? (
          <KineticSubtitle
            words={subtitles}
            position="safe-zone"
            hiddenIntervals={dashboardIntervals}
            fontFamily={subtitleStyle?.fontFamily}
            fontWeight={subtitleStyle?.fontWeight}
            color={subtitleStyle?.color ?? "#FFFFFF"}
            highlightColor={subtitleStyle?.highlightColor ?? "#EBB24A"}
            strokePx={subtitleStyle?.strokePx}
            strokeColor={subtitleStyle?.strokeColor}
            beats={subtitleStyle?.syncTo === "beat" ? musicBeats : undefined}
          />
        ) : (
          <Subtitle
            words={subtitles}
            position="safe-zone"
            hiddenIntervals={dashboardIntervals}
            fontFamily={subtitleStyle?.fontFamily}
            fontWeight={subtitleStyle?.fontWeight}
            color={subtitleStyle?.color ?? "#FFFFFF"}
            highlightColor={subtitleStyle?.highlightColor ?? "#FFFFFF"}
            strokePx={subtitleStyle?.strokePx}
            strokeColor={subtitleStyle?.strokeColor}
          />
        )
      )}

      {/* ─── AUDIO ─── */}
      {voiceoverUrl && <Audio src={voiceoverUrl} />}
      {musicUrl && (
        <Audio
          src={musicUrl}
          volume={interpolate(frame, [0, 15], [0, 0.15], {
            extrapolateRight: "clamp",
          })}
        />
      )}
    </AbsoluteFill>
  );
};
