import React from "react";
import { AbsoluteFill, Audio, interpolate, useCurrentFrame } from "remotion";
import { BackgroundVideo } from "../components/BackgroundVideo";
import { Subtitle } from "../components/Subtitle";
import type { TalkingHeadReelProps } from "../types";

export const TalkingHeadReel: React.FC<TalkingHeadReelProps> = ({
  videoUrl,
  subtitles,
  musicUrl,
}) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <BackgroundVideo src={videoUrl} />
      <Subtitle words={subtitles} position="bottom" />
      {musicUrl && (
        <Audio
          src={musicUrl}
          volume={interpolate(frame, [0, 15], [0, 0.1], {
            extrapolateRight: "clamp",
          })}
        />
      )}
    </AbsoluteFill>
  );
};
