import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { SPRING_PRESETS } from "../utils/spring-presets";
import { spaceFont } from "../utils/fonts";

type Animation =
  | "fadeUp"
  | "fadeIn"
  | "scaleIn"
  | "slideLeft"
  | "slideRight"
  | "wordByWord";

interface AnimatedTextProps {
  text: string;
  animation?: Animation;
  fontSize?: number;
  color?: string;
  fontWeight?: string;
  fontFamily?: string;
  delay?: number;
  preset?: keyof typeof SPRING_PRESETS;
  textAlign?: React.CSSProperties["textAlign"];
  uppercase?: boolean;
  letterSpacing?: number;
  textShadow?: string;
  style?: React.CSSProperties;
}

export const AnimatedText: React.FC<AnimatedTextProps> = ({
  text,
  animation = "fadeUp",
  fontSize = 64,
  color = "#FFFFFF",
  fontWeight = "800",
  fontFamily = spaceFont,
  delay = 0,
  preset = "punchy",
  textAlign = "center",
  uppercase = false,
  letterSpacing = -1,
  textShadow = "0 2px 20px rgba(0,0,0,0.8), 0 0 60px rgba(0,0,0,0.4)",
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const displayText = uppercase ? text.toUpperCase() : text;

  // Word-by-word animation
  if (animation === "wordByWord") {
    // Split per \n in righe, poi ogni riga in parole
    const lines = displayText.split("\n").map((line) => line.trim()).filter((l) => l.length > 0);
    const justifyContent =
      textAlign === "center"
        ? "center"
        : textAlign === "right"
          ? "flex-end"
          : "flex-start";

    // Conta totale parole per gestire i delay progressivi attraverso le righe
    let wordIndex = 0;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: justifyContent,
          gap: `${fontSize * 0.2}px`,
          padding: "0 60px",
          ...style,
        }}
      >
        {lines.map((line, lineIdx) => {
          const lineWords = line.split(" ");
          return (
            <div
              key={lineIdx}
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent,
                gap: `0 ${fontSize * 0.25}px`,
              }}
            >
              {lineWords.map((word, i) => {
                const currentWordIndex = wordIndex++;
                const wordDelay = delay + currentWordIndex * 3;
                const progress = spring({
                  frame: frame - wordDelay,
                  fps,
                  config: SPRING_PRESETS[preset],
                });
                return (
                  <span
                    key={i}
                    style={{
                      fontSize,
                      color,
                      fontWeight,
                      fontFamily,
                      letterSpacing,
                      textShadow,
                      lineHeight: 1.15,
                      display: "inline-block",
                      opacity: progress,
                      transform: `translateY(${interpolate(progress, [0, 1], [30, 0])}px)`,
                    }}
                  >
                    {word}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  // Standard animations
  const progress = spring({
    frame: frame - delay,
    fps,
    config: SPRING_PRESETS[preset],
  });

  const animations: Record<
    Exclude<Animation, "wordByWord">,
    React.CSSProperties
  > = {
    fadeUp: {
      opacity: progress,
      transform: `translateY(${interpolate(progress, [0, 1], [50, 0])}px)`,
    },
    fadeIn: {
      opacity: progress,
    },
    scaleIn: {
      opacity: progress,
      transform: `scale(${interpolate(progress, [0, 1], [0.5, 1])})`,
    },
    slideLeft: {
      opacity: progress,
      transform: `translateX(${interpolate(progress, [0, 1], [120, 0])}px)`,
    },
    slideRight: {
      opacity: progress,
      transform: `translateX(${interpolate(progress, [0, 1], [-120, 0])}px)`,
    },
  };

  return (
    <div
      style={{
        fontSize,
        color,
        fontWeight,
        fontFamily,
        textAlign,
        lineHeight: 1.15,
        letterSpacing,
        textShadow,
        padding: "0 60px",
        textTransform: uppercase ? "uppercase" : undefined,
        ...animations[animation],
        ...style,
      }}
    >
      {displayText}
    </div>
  );
};
