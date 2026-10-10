import React from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { archivoBlackFont, interFont } from "../utils/fonts";

export type CoverBox = { left: number; top: number; width: number; height: number };
export type CoverWord = { text: string; startFrame: number; endFrame: number };

/** One burned-in caption, cloned so the new plate sits on top of it. */
export type CoverBlock = {
  startFrame: number;
  endFrame: number;
  /** card = white rounded plate, words go gray → black as they are spoken.
   *  stroke = white letters, thick black outline, whole phrase at once. */
  style: "card" | "stroke";
  box: CoverBox;
  words: CoverWord[];
};

export type CoverSubsProps = {
  videoUrl: string;
  blocks: CoverBlock[];
};

export const CoverSubs: React.FC<CoverSubsProps> = ({ videoUrl, blocks }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const block = blocks.find((b) => frame >= b.startFrame && frame < b.endFrame);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={videoUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      {block?.style === "card" && <Card frame={frame} block={block} width={width} height={height} />}
      {block?.style === "stroke" && <Stroke block={block} width={width} height={height} />}
    </AbsoluteFill>
  );
};

const Card: React.FC<{ frame: number; block: CoverBlock; width: number; height: number }> = ({ frame, block, width, height }) => {
  const { box } = block;
  const boxH = box.height * height;
  return (
    <div
      style={{
        position: "absolute",
        left: box.left * width,
        top: box.top * height,
        width: box.width * width,
        height: boxH,
        background: "#ffffff",
        borderRadius: Math.round(boxH * 0.12),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "3% 5%",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          textAlign: "center",
          fontFamily: interFont,
          fontWeight: 800,
          fontSize: Math.round(boxH * 0.16),
          lineHeight: 1.12,
          letterSpacing: "-0.02em",
        }}
      >
        {block.words.map((w, i) => (
          <span key={i} style={{ color: frame >= w.startFrame ? "#1c1c1c" : "#c5c5c5" }}>
            {w.text}{" "}
          </span>
        ))}
      </div>
    </div>
  );
};

const Stroke: React.FC<{ block: CoverBlock; width: number; height: number }> = ({ block, width, height }) => {
  const lines: string[][] = [[]];
  for (const w of block.words) {
    if (w.text === "\n") lines.push([]);
    else lines[lines.length - 1].push(w.text);
  }
  const fontSize = Math.round(height * 0.034);
  const stroke = Math.max(6, Math.round(height * 0.005));
  const lineTop = [block.box.top, block.box.top + 0.054];
  const padY = Math.round(fontSize * 0.42);
  const padX = Math.round(fontSize * 0.35);
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: (lineTop[i] ?? lineTop[0] + i * 0.052) * height,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#111111",
              borderRadius: Math.round(fontSize * 0.18),
              padding: `${padY}px ${padX}px`,
              minWidth: width * (line.join(" ").length > 18 ? 0.84 : line.join(" ").length > 12 ? 0.58 : 0.34),
              boxSizing: "border-box",
              color: "#ffffff",
              fontFamily: archivoBlackFont,
              fontWeight: 400,
              fontSize,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              whiteSpace: "nowrap",
              WebkitTextStroke: `${stroke}px #000`,
              paintOrder: "stroke fill",
            }}
          >
            {line.join(" ")}
          </div>
        </div>
      ))}
    </>
  );
};
