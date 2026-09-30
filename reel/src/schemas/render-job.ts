import { z } from "zod";

export const RenderJobSchema = z.object({
  compositionId: z.enum([
    "BasicReel",
    "TalkingHeadReel",
    "ProductShowcase",
    "TextOverlayReel",
  ]),
  props: z.record(z.string(), z.unknown()),
  durationInFrames: z.number().int().positive(),
  outputDir: z.string(),
  outputFilename: z.string().default("final.mp4"),
});

export type RenderJob = z.infer<typeof RenderJobSchema>;
