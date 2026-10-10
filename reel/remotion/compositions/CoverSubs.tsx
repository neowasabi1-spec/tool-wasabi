import React from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { antonFont } from "../utils/fonts";

export type CoverBand = { top: number; height: number; color?: string };
export type CoverCaption = { text: string; startFrame: number; endFrame: number };

export type CoverSubsProps = {
  videoUrl: string;
  bands: CoverBand[];
  captions: CoverCaption[];
};

export const CoverSubs: React.FC<CoverSubsProps> = ({ videoUrl, bands, captions }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const line = captions.find((c) => frame >= c.startFrame && frame < c.endFrame);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={videoUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      {bands.map((band, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${band.top * 100}%`,
            height: `${band.height * 100}%`,
            background: band.color || "#111111",
          }}
        />
      ))}
      {line && (
        <div
          style={{
            position: "absolute",
            left: 48,
            right: 48,
            top: height * 0.78,
            textAlign: "center",
            color: "#fff",
            fontFamily: antonFont,
            fontSize: Math.round(height * 0.055),
            lineHeight: 1.05,
            textTransform: "uppercase",
            textShadow: "0 2px 0 #000",
          }}
        >
          {line.text}
        </div>
      )}
    </AbsoluteFill>
  );
};
