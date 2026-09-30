import { z } from "zod";

/**
 * Schema della scena TIPOGRAFICA parametrica (add-on "Tipografia Cinetica").
 * Tutto via JSON nello script.json → niente React da scrivere. Costo zero API
 * (componente Remotion, salta la generazione video). Centralizzato qui così
 * script.ts (input), types.ts (props) e TypoScene.tsx condividono UNA forma.
 */

const TypoLineSchema = z.object({
  t: z.string().describe("Il testo della riga."),
  size: z.number().optional().describe("Dimensione px (default: grande)."),
  accent: z.boolean().optional().describe("Se true, riga nel colore accento."),
  weight: z.number().optional().describe("fontWeight (per 'inter')."),
  font: z.enum(["black", "anton", "inter"]).optional().describe("black=Archivo Black (default), anton=condensed, inter=neutro."),
});

export const TypoSchema = z.object({
  mode: z.enum(["lines", "flip", "repeat", "counter"]).describe(
    "lines = righe di testo animate · flip = stacco chiaro→scuro a metà · repeat = ripetizione tipografica (texture) · counter = numero che sale."
  ),
  bg: z.enum(["light", "dark"]).optional().describe("Sfondo: chiaro o scuro (alto contrasto). Default dark. In 'flip' è automatico."),
  accent: z.string().optional().describe("Colore accento HEX. Default terracotta #D97757."),
  reveal: z.enum(["wipe", "fade", "rise"]).optional().describe("Animazione d'entrata. Default wipe (secco)."),
  stagger: z.number().optional().describe("Frame tra una riga e l'altra. Default 8."),
  kicker: z.string().optional().describe("Piccola label sopra (es. 'ISCRIZIONI')."),
  // mode lines
  lines: z.array(TypoLineSchema).optional().describe("[mode lines] le righe centrate."),
  // mode flip
  phaseA: z.array(TypoLineSchema).optional().describe("[mode flip] righe nella fase chiara."),
  phaseB: z.array(TypoLineSchema).optional().describe("[mode flip] righe nella fase scura."),
  flipAt: z.number().optional().describe("[mode flip] frazione 0-1 della durata in cui avviene lo stacco. Default 0.45."),
  // mode repeat
  repeatWord: z.string().optional().describe("[mode repeat] parola ripetuta come texture."),
  centerLines: z.array(TypoLineSchema).optional().describe("[mode repeat] righe leggibili al centro."),
  // mode counter
  from: z.number().optional().describe("[mode counter] valore iniziale (default 0)."),
  to: z.number().optional().describe("[mode counter] valore finale."),
  label: z.string().optional().describe("[mode counter] label sotto il numero."),
  sublabel: z.string().optional().describe("[mode counter] seconda label (accento)."),
});

export type TypoLine = z.infer<typeof TypoLineSchema>;
export type TypoSceneData = z.infer<typeof TypoSchema>;
