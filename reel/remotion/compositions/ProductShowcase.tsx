import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { BackgroundImage } from "../components/BackgroundImage";
import { AnimatedText } from "../components/AnimatedText";
import { TransitionWipe } from "../components/TransitionWipe";
import { interFont } from "../utils/fonts";
import type { ProductShowcaseProps } from "../types";

export const ProductShowcase: React.FC<ProductShowcaseProps> = ({
  title,
  products,
  voiceoverUrl,
  musicUrl,
}) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const titleDuration = Math.round(fps * 2);
  const remainingFrames = durationInFrames - titleDuration;
  const perProduct = Math.floor(remainingFrames / products.length);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      {/* Title */}
      <Sequence from={0} durationInFrames={titleDuration}>
        <TransitionWipe type="fadeBlack">
          <AbsoluteFill
            style={{
              justifyContent: "center",
              alignItems: "center",
              background: "linear-gradient(180deg, #1a1a2e 0%, #0a0a0a 100%)",
            }}
          >
            <AnimatedText
              text={title}
              animation="fadeUp"
              fontSize={68}
              preset="punchy"
            />
          </AbsoluteFill>
        </TransitionWipe>
      </Sequence>

      {/* Products */}
      {products.map((product, i) => {
        const productStart = titleDuration + i * perProduct;

        return (
          <Sequence key={i} from={productStart} durationInFrames={perProduct}>
            <TransitionWipe type="fadeBlack" durationInFrames={8}>
              <AbsoluteFill>
                <BackgroundImage
                  src={product.imageUrl}
                  kenBurns
                  zoomRange={[1, 1.1]}
                />
                <AbsoluteFill
                  style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
                />
                {/* Product info overlay */}
                <AbsoluteFill
                  style={{
                    justifyContent: "flex-end",
                    padding: "0 60px 240px",
                  }}
                >
                  <AnimatedText
                    text={product.name}
                    animation="fadeUp"
                    fontSize={52}
                    fontWeight="700"
                    delay={5}
                  />
                  {product.price && (
                    <AnimatedText
                      text={product.price}
                      animation="fadeUp"
                      fontSize={40}
                      color="#FFD700"
                      fontWeight="600"
                      delay={12}
                    />
                  )}
                  {product.features?.map((feat, fi) => (
                    <AnimatedText
                      key={fi}
                      text={`• ${feat}`}
                      animation="slideLeft"
                      fontSize={32}
                      color="#E0E0E0"
                      fontWeight="400"
                      delay={18 + fi * 6}
                      textAlign="left"
                    />
                  ))}
                </AbsoluteFill>
              </AbsoluteFill>
            </TransitionWipe>
          </Sequence>
        );
      })}

      {/* Audio */}
      {voiceoverUrl && <Audio src={voiceoverUrl} />}
      {musicUrl && (
        <Audio
          src={musicUrl}
          volume={interpolate(frame, [0, 15], [0, 0.12], {
            extrapolateRight: "clamp",
          })}
        />
      )}
    </AbsoluteFill>
  );
};
