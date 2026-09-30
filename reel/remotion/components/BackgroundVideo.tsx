import React from "react";
import { OffthreadVideo, useVideoConfig } from "remotion";

interface BackgroundVideoProps {
  src: string;
  style?: React.CSSProperties;
}

export const BackgroundVideo: React.FC<BackgroundVideoProps> = ({
  src,
  style,
}) => {
  const { width, height } = useVideoConfig();

  return (
    <OffthreadVideo
      src={src}
      style={{
        position: "absolute",
        width,
        height,
        objectFit: "cover",
        ...style,
      }}
    />
  );
};
