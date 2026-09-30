import { z } from "zod";
import { TypoSchema } from "../src/schemas/typo-schema";

// --- Shared primitives ---

export const KineticSceneDataSchema = z.object({
  value: z.string(),
  suffix: z.string().optional(),
  label: z.string().optional(),
  source: z.string().optional(),
  palette: z
    .object({
      bg: z.string().optional(),
      primary: z.string().optional(),
      accent: z.string().optional(),
      label: z.string().optional(),
      source: z.string().optional(),
    })
    .optional(),
});

const KineticDashboardPaletteSchema = z
  .object({
    bg: z.string().optional(),
    surface: z.string().optional(),
    surfaceDeep: z.string().optional(),
    primary: z.string().optional(),
    primaryDim: z.string().optional(),
    label: z.string().optional(),
    labelDim: z.string().optional(),
    grid: z.string().optional(),
    divider: z.string().optional(),
  })
  .optional();

const KineticDashboardPanelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("trend"),
    title: z.string(),
    meta: z.string().optional(),
    value: z.string(),
    suffix: z.string().optional(),
    subtitle: z.string().optional(),
    dataPoints: z.array(z.tuple([z.number(), z.number()])).optional(),
  }),
  z.object({
    type: z.literal("donut"),
    title: z.string(),
    meta: z.string().optional(),
    centerValue: z.string().optional(),
    centerLabel: z.string().optional(),
    segments: z
      .array(
        z.object({
          label: z.string(),
          value: z.number().positive(),
          color: z.string().optional(),
        })
      )
      .min(2)
      .max(6),
  }),
  z.object({
    type: z.literal("bars"),
    title: z.string(),
    meta: z.string().optional(),
    value: z.string(),
    valueLabel: z.string().optional(),
    subtitle: z.string().optional(),
    bars: z
      .array(z.object({ label: z.string(), value: z.number() }))
      .min(2)
      .max(12),
    highlightIndex: z.number().int().nonnegative().optional(),
  }),
]);

export const KineticDashboardSceneDataSchema = z.object({
  panels: z.array(KineticDashboardPanelSchema).min(1).max(3),
  palette: KineticDashboardPaletteSchema,
});

export const SceneSchema = z.object({
  text: z.string(),
  imageUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  kinetic: KineticSceneDataSchema.optional(),
  kineticDashboard: KineticDashboardSceneDataSchema.optional(),
  dashboardComponent: z.string().optional(),
  typo: TypoSchema.optional(),
  kenBurnsRange: z.tuple([z.number(), z.number()]).optional(),
  /** Se true, il sottotitolo globale è soppresso durante questa scena (come per
   *  le card). Usato per gli spezzoni splice che hanno già caption impresse. */
  hideSubtitle: z.boolean().optional(),
  /** Targa lower-third da talk show (es. "LA SUA EX SDR"), visibile per tutta
   *  la scena (o nella finestra nameplateWindow). Render: Nameplate, bottom ~16%. */
  nameplate: z.string().optional(),
  /** Finestra [fromSec, toSec] di visibilita' della nameplate nella scena. */
  nameplateWindow: z.tuple([z.number(), z.number()]).optional(),
  durationInFrames: z.number().int().positive(),
});

export const SubtitleWordSchema = z.object({
  text: z.string(),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
});

export const ProductSchema = z.object({
  imageUrl: z.string(),
  name: z.string(),
  price: z.string().optional(),
  features: z.array(z.string()).optional(),
});

export const TextBlockSchema = z.object({
  text: z.string(),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
  style: z
    .object({
      fontSize: z.number().optional(),
      color: z.string().optional(),
      fontWeight: z.string().optional(),
    })
    .optional(),
});

// --- Composition props ---

export const SubtitleStyleSchema = z.object({
  fontFamily: z.string().optional(),
  fontWeight: z.union([z.number(), z.string()]).optional(),
  color: z.string().optional(),
  highlightColor: z.string().optional(),
  strokePx: z.number().optional(),
  strokeColor: z.string().optional(),
  /** Se true, BasicReel usa un sottotitolo KINETIC invece di Subtitle (karaoke
   *  piatto). Quale: vedi `variant`. */
  kinetic: z.boolean().optional(),
  /** Variante kinetic (solo se kinetic=true):
   *  - "rise" (default): KineticSubtitle — rise word-by-word + parola attiva oro
   *    (voto 9/10), copertura totale, posizione safe-zone. Supporta syncTo beat.
   *  - "motion": KineticCaptionsArt — motion typography di produzione (voto 9/10,
   *    2026-06-20): UN solo font (captionFont, default Anton), parola-hero
   *    ingrandita+oro+glow, parole future fantasma, banda bassa centrata,
   *    larghezza robusta via measureText (mai off-screen). Per video frontali/
   *    talking-head dinamici. */
  variant: z.enum(["rise", "motion"]).optional(),
  /** Sorgente di sincronizzazione dei sottotitoli kinetic:
   *  - "voice" (default): le parole si agganciano ai word-timestamps della voce.
   *  - "beat": le parole si agganciano alla griglia `musicBeats` (contenuto
   *    music-driven, voce già recitata sul beat). Richiede musicBeats nel reel.
   *  (syncTo beat è supportato solo dalla variant "rise".) */
  syncTo: z.enum(["voice", "beat"]).optional(),
  /** [variant motion] Font UNICO (deve essere caricato in fonts.ts). Default anton. */
  captionFont: z.enum(["anton", "oswald", "bebas", "archivo", "inter"]).optional(),
  /** [variant motion] Dimensione base (px @ 1080w). Default 92. */
  baseSize: z.number().optional(),
  /** [variant motion] Moltiplicatore dimensione della parola-hero. Default 1.34. */
  heroScale: z.number().optional(),
  /** [variant motion] Distanza dal fondo (frazione 0-1). Default 0.15 (banda bassa). */
  bottomPct: z.number().optional(),
  /** [variant motion] Parole massime per blocco prima del wrap. Default 4. */
  maxWordsPerGroup: z.number().optional(),
});

export const BasicReelSchema = z.object({
  hook: z.string(),
  scenes: z.array(SceneSchema),
  cta: z.string(),
  voiceoverUrl: z.string().optional(),
  musicUrl: z.string().optional(),
  subtitles: z.array(SubtitleWordSchema).optional(),
  /** Override stile sottotitoli (default = Inter bold bianco). Per reel che
   *  vogliono un look diverso (es. un brand cliente = serif GT Super bianco+outline). */
  subtitleStyle: SubtitleStyleSchema.optional(),
  /** Griglia di beat (in frame @ fps composition) della musica, da `pnpm beat-detect`.
   *  Usata solo quando subtitleStyle.syncTo === "beat" (variant kinetic "rise"). */
  musicBeats: z.array(z.number()).optional(),
});

export const TalkingHeadReelSchema = z.object({
  videoUrl: z.string(),
  subtitles: z.array(SubtitleWordSchema),
  musicUrl: z.string().optional(),
});

export const ProductShowcaseSchema = z.object({
  title: z.string(),
  products: z.array(ProductSchema),
  voiceoverUrl: z.string().optional(),
  musicUrl: z.string().optional(),
});

export const TextOverlayReelSchema = z.object({
  backgroundVideoUrl: z.string(),
  textBlocks: z.array(TextBlockSchema),
  musicUrl: z.string().optional(),
});

// --- Inferred types ---

export type Scene = z.infer<typeof SceneSchema>;
export type SubtitleWord = z.infer<typeof SubtitleWordSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type BasicReelProps = z.infer<typeof BasicReelSchema>;
export type TalkingHeadReelProps = z.infer<typeof TalkingHeadReelSchema>;
export type ProductShowcaseProps = z.infer<typeof ProductShowcaseSchema>;
export type TextOverlayReelProps = z.infer<typeof TextOverlayReelSchema>;
