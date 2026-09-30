import { z } from "zod";

/**
 * Schemi del processo "refresh creativo" (creare varianti di una top ad esistente).
 *
 * Il deconstruct (scripts/refresh-deconstruct.ts) analizza l'ad originale shot per
 * shot e per ogni shot propone un VERDETTO DI RIPRODUCIBILITÀ — come la scena va
 * ricreata nel nuovo reel. Il verdetto è una PROPOSTA: l'umano lo approva/ribalta
 * alla TABELLA SCENE prima di spendere un solo credito.
 *
 * Vocabolario verdetti (4 valori, usati identici in deconstruct + selection.md + skill):
 *  - "ai-recreate" → scena AI nuova: keyframe Gemini + image-to-video ancorato
 *                    (oggetti/atmosfere SENZA testo e SENZA identità specifica).
 *  - "static-png"  → PNG statico (pack-shot pulito) + Ken Burns, via scene.imageUrl
 *                    (prodotto-con-scritte dove esiste un asset brand pulito).
 *  - "card"        → componente React registrato (badge/recensioni/CTA/QR/KPI),
 *                    via scene.dashboardComponent.
 *  - "splice"      → segmento VERBATIM dell'ad originale, via scene.sourceClip
 *                    (talking-head, before/after dove l'identità deve combaciare,
 *                    o prodotto-con-scritte senza un PNG pulito).
 */
export const ReproductionVerdictSchema = z.enum([
  "ai-recreate",
  "static-png",
  "card",
  "splice",
]);
export type ReproductionVerdict = z.infer<typeof ReproductionVerdictSchema>;

export const DeconstructShotSchema = z.object({
  index: z.number().int().positive().describe("Ordinale dello shot, 1-based"),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
  framePath: z
    .string()
    .describe("Path relativo alla project dir del frame rappresentativo, es. 'frames/shot-03.png'"),
  vo: z.string().describe("Sottostringa del voiceover mappata su questo shot (può essere '')"),
  onScreenText: z
    .string()
    .describe("Testo a schermo letto verbatim dal vision (insegne, prezzi, card, label). '' se nessuno"),
  subject: z.string().describe("Cosa è inquadrato (soggetto principale)"),
  setting: z.string().describe("Ambiente / contesto"),
  motion: z.string().describe("Movimento di camera + del soggetto"),
  hasReadableText: z.boolean().describe("Lo shot dipende da testo leggibile (Kling lo rovinerebbe)?"),
  hasLogoOrUI: z.boolean().describe("Contiene logo, UI di app, status bar, overlay grafici?"),
  isProductWithText: z.boolean().describe("Prodotto con scritte/label/packaging leggibile?"),
  isTalkingHead: z.boolean().describe("Volto umano che parla in sync col VO?"),
  isBeforeAfter: z.boolean().describe("Confronto before/after dove l'identità deve combaciare?"),
  verdict: ReproductionVerdictSchema.describe("Proposta di riproducibilità — l'umano la conferma/ribalta"),
  rationale: z.string().describe("Una riga: perché questo verdetto"),
  confidence: z.number().min(0).max(1).describe("Confidenza del modello sul verdetto (<0.6 = rivedere a mano)"),
});
export type DeconstructShot = z.infer<typeof DeconstructShotSchema>;

export const DeconstructionSchema = z.object({
  meta: z.object({
    source: z.string().describe("Path assoluto dell'ad originale"),
    durationSec: z.number().positive(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    shotThreshold: z.number().describe("Soglia scene-change ffmpeg usata"),
    shotCount: z.number().int().nonnegative(),
    generatedAt: z.string().describe("ISO timestamp passato via --now (no Date.now nei test)"),
    whisperModel: z.string().optional(),
    visionModel: z.string().optional(),
  }),
  transcription: z.object({
    full: z.string(),
    segments: z.array(
      z.object({
        startSec: z.number().nonnegative(),
        endSec: z.number().positive(),
        text: z.string(),
      })
    ),
  }),
  shots: z.array(DeconstructShotSchema),
});
export type Deconstruction = z.infer<typeof DeconstructionSchema>;

/** Esito del GATE V (refresh-verify): match soggetto clip↔keyframe per scena. */
export const VerifyResultSchema = z.object({
  sceneNum: z.number().int().positive(),
  keyframe: z.string(),
  clip: z.string(),
  match: z.boolean(),
  score: z.number().min(0).max(10),
  reason: z.string(),
  status: z.enum(["pass", "block"]),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
