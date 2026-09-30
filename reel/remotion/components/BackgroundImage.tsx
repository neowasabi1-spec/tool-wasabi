import React from "react";
import { Img, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface BackgroundImageProps {
  src: string;
  kenBurns?: boolean;
  zoomRange?: [number, number];
}

export const BackgroundImage: React.FC<BackgroundImageProps> = ({
  src,
  kenBurns = true,
  zoomRange = [1, 1.15],
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const scale = kenBurns
    ? interpolate(frame, [0, durationInFrames], zoomRange, {
        extrapolateRight: "clamp",
      })
    : 1;

  return (
    <Img
      src={src}
      style={{
        position: "absolute",
        width,
        height,
        objectFit: "cover",
        transform: `scale(${scale})`,
      }}
    />
  );
};
