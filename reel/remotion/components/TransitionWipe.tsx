import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type TransitionType = "fadeBlack" | "slideUp" | "slideLeft" | "crossfade";

interface TransitionWipeProps {
  type?: TransitionType;
  durationInFrames?: number;
  children: React.ReactNode;
}

export const TransitionWipe: React.FC<TransitionWipeProps> = ({
  type = "fadeBlack",
  durationInFrames = 10,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames: totalDuration } = useVideoConfig();

  // Fade in at start
  const enterProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Fade out at end
  const exitProgress = interpolate(
    frame,
    [totalDuration - durationInFrames, totalDuration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const progress = Math.min(enterProgress, exitProgress);

  const transitionStyles: Record<TransitionType, React.CSSProperties> = {
    fadeBlack: { opacity: progress },
    crossfade: { opacity: progress },
    slideUp: {
      opacity: enterProgress,
      transform: `translateY(${interpolate(enterProgress, [0, 1], [60, 0])}px)`,
    },
    slideLeft: {
      opacity: enterProgress,
      transform: `translateX(${interpolate(enterProgress, [0, 1], [100, 0])}px)`,
    },
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        ...transitionStyles[type],
      }}
    >
      {children}
    </div>
  );
};
