import React from "react";
import {
  AbsoluteFill,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { BackgroundVideo } from "../components/BackgroundVideo";
import { interFont } from "../utils/fonts";
import { SPRING_PRESETS } from "../utils/spring-presets";
import type { TextOverlayReelProps } from "../types";

export const TextOverlayReel: React.FC<TextOverlayReelProps> = ({
  backgroundVideoUrl,
  textBlocks,
  musicUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <BackgroundVideo src={backgroundVideoUrl} />

      {/* Dim overlay */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.25)" }} />

      {/* Text blocks */}
      {textBlocks.map((block, i) => {
        if (frame < block.startFrame || frame > block.endFrame) return null;

        const localFrame = frame - block.startFrame;
        const blockDuration = block.endFrame - block.startFrame;

        const enterProgress = spring({
          frame: localFrame,
          fps,
          config: SPRING_PRESETS.punchy,
        });

        const exitProgress =
          localFrame > blockDuration - 8
            ? interpolate(
                localFrame,
                [blockDuration - 8, blockDuration],
                [1, 0],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              )
            : 1;

        return (
          <AbsoluteFill
            key={i}
            style={{
              justifyContent: "center",
              alignItems: "center",
              opacity: enterProgress * exitProgress,
              transform: `scale(${interpolate(enterProgress, [0, 1], [0.8, 1])})`,
            }}
          >
            <div
              style={{
                fontSize: block.style?.fontSize ?? 72,
                color: block.style?.color ?? "#FFFFFF",
                fontWeight: block.style?.fontWeight ?? "800",
                fontFamily: interFont,
                textAlign: "center",
                lineHeight: 1.15,
                padding: "0 50px",
                textShadow: "0 4px 20px rgba(0,0,0,0.7)",
              }}
            >
              {block.text}
            </div>
          </AbsoluteFill>
        );
      })}

      {/* Music */}
      {musicUrl && (
        <Audio
          src={musicUrl}
          volume={interpolate(frame, [0, 15], [0, 0.3], {
            extrapolateRight: "clamp",
          })}
        />
      )}
    </AbsoluteFill>
  );
};
