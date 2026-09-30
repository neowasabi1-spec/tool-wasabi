import React from "react";
import { Img, spring, useCurrentFrame, useVideoConfig } from "remotion";

interface LogoWatermarkProps {
  src: string;
  size?: number;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  margin?: number;
  delay?: number;
}

export const LogoWatermark: React.FC<LogoWatermarkProps> = ({
  src,
  size = 80,
  position = "bottom-right",
  margin = 40,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = spring({
    frame: frame - delay,
    fps,
    config: { mass: 1, stiffness: 80, damping: 20 },
  });

  const positionStyles: Record<string, React.CSSProperties> = {
    "bottom-right": { bottom: margin, right: margin },
    "bottom-left": { bottom: margin, left: margin },
    "top-right": { top: margin, right: margin },
    "top-left": { top: margin, left: margin },
  };

  return (
    <Img
      src={src}
      style={{
        position: "absolute",
        width: size,
        height: size,
        objectFit: "contain",
        opacity,
        ...positionStyles[position],
      }}
    />
  );
};
