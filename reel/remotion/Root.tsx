import React from "react";
import { Composition } from "remotion";
import { BasicReel } from "./compositions/BasicReel";
import { TalkingHeadReel } from "./compositions/TalkingHeadReel";
import { ProductShowcase } from "./compositions/ProductShowcase";
import { TextOverlayReel } from "./compositions/TextOverlayReel";
import { KineticNumber } from "./components/KineticNumber";
import { KineticDashboard } from "./components/KineticDashboard";
import { DemoCard } from "./components/dashboards/DemoCard";
import {
  BasicReelSchema,
  TalkingHeadReelSchema,
  ProductShowcaseSchema,
  TextOverlayReelSchema,
} from "./types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// Default props for Remotion Studio preview
const defaultBasicReel = {
  hook: "Il 90% delle persone sbaglia questo",
  scenes: [
    {
      text: "Pensano che il problema sia il prezzo",
      durationInFrames: 90,
    },
    {
      text: "Ma il vero problema è la percezione del valore",
      durationInFrames: 90,
    },
    {
      text: "Chi comunica bene, vende di più",
      durationInFrames: 90,
    },
  ],
  cta: "Seguimi per altri consigli →",
};

const defaultTalkingHead = {
  videoUrl: "",
  subtitles: [
    { text: "Ciao,", startFrame: 0, endFrame: 15 },
    { text: "oggi", startFrame: 16, endFrame: 30 },
    { text: "parliamo", startFrame: 31, endFrame: 50 },
    { text: "di", startFrame: 51, endFrame: 60 },
    { text: "marketing", startFrame: 61, endFrame: 90 },
  ],
};

const defaultProductShowcase = {
  title: "I nostri prodotti migliori",
  products: [
    { imageUrl: "", name: "Prodotto Alpha", price: "€99", features: ["Feature 1", "Feature 2"] },
    { imageUrl: "", name: "Prodotto Beta", price: "€149", features: ["Feature A", "Feature B"] },
  ],
};

const defaultTextOverlay = {
  backgroundVideoUrl: "",
  textBlocks: [
    { text: "Non è questione di talento", startFrame: 0, endFrame: 60 },
    { text: "È questione di sistema", startFrame: 70, endFrame: 130 },
    { text: "Costruisci il tuo oggi", startFrame: 140, endFrame: 200 },
  ],
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BasicReel"
        component={BasicReel}
        durationInFrames={FPS * 15}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        schema={BasicReelSchema}
        defaultProps={defaultBasicReel}
      />
      <Composition
        id="TalkingHeadReel"
        component={TalkingHeadReel}
        durationInFrames={FPS * 30}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        schema={TalkingHeadReelSchema}
        defaultProps={defaultTalkingHead}
      />
      <Composition
        id="ProductShowcase"
        component={ProductShowcase}
        durationInFrames={FPS * 20}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        schema={ProductShowcaseSchema}
        defaultProps={defaultProductShowcase}
      />
      <Composition
        id="TextOverlayReel"
        component={TextOverlayReel}
        durationInFrames={FPS * 10}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        schema={TextOverlayReelSchema}
        defaultProps={defaultTextOverlay}
      />
      <Composition
        id="KineticNumberDemo"
        component={KineticNumberDemo}
        durationInFrames={FPS * 4}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="KineticDashboardDemo"
        component={KineticDashboardDemo}
        durationInFrames={FPS * 6}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* Esempio del pattern dashboardComponent — template per le card cliente */}
      <Composition
        id="DemoCard"
        component={DemoCard}
        durationInFrames={FPS * 5}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};

const KineticNumberDemo: React.FC = () => (
  <KineticNumber
    value="391"
    suffix="%"
    label="probabilità in più"
    source="VELOCIFY · STUDIO SU 3,5M LEAD"
  />
);

// Demo dataset that maps to "una visione completa, qualsiasi canale, tempo reale" frame.
// Use as reference template for new KINETIC-DASHBOARD scenes in scripts.
const KineticDashboardDemo: React.FC = () => (
  <KineticDashboard
    panels={[
      {
        type: "trend",
        title: "Conversazioni gestite",
        meta: "ultimi 30 giorni",
        value: "+127",
        suffix: "%",
        subtitle: "vs. mese precedente",
      },
      {
        type: "donut",
        title: "Mix canali",
        meta: "oggi · live",
        centerValue: "4",
        centerLabel: "canali",
        segments: [
          { label: "WhatsApp", value: 34 },
          { label: "Chat web", value: 26 },
          { label: "Email", value: 22 },
          { label: "SMS", value: 18 },
        ],
      },
      {
        type: "bars",
        title: "Lead qualificati",
        meta: "ultimi 7 giorni",
        value: "91",
        valueLabel: "oggi",
        subtitle: "media 7gg: 69",
        bars: [
          { label: "Lun", value: 47 },
          { label: "Mar", value: 62 },
          { label: "Mer", value: 51 },
          { label: "Gio", value: 78 },
          { label: "Ven", value: 69 },
          { label: "Sab", value: 84 },
          { label: "Oggi", value: 91 },
        ],
      },
    ]}
  />
);
