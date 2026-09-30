/**
 * Gemini 3 Pro Image client per Stage 1.7 Storyboard.
 *
 * Validato 2026-05-27 nel mini-pilot 6-way (vedi
 * [[project-pilot-image-gen-6way-2026-05-27]]) come miglior modello photoreal
 * italiano (9.5/10 vs Imagen 4 Ultra 7/10, Nano Banana Pro 4k 8.5/10,
 * Seedream 4.5 6/10, Flux 2 Pro 8.5/10, Gemini 3.1 Flash 7/10).
 *
 * Pattern uniforme a gemini-vision.ts (stesso SDK @google/genai, stesso
 * singleton client, stesso error handling con 1 retry).
 *
 * Override modello: env GEMINI_IMAGE_MODEL (es. "gemini-3.1-flash-image-preview"
 * per batch economico).
 */

import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { GoogleGenAI, type Part } from "@google/genai";

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview";

const DEFAULT_STYLE_ANCHOR =
  "Photoreal style iPhone photography, vertical 9:16 portrait orientation, " +
  "natural lighting, candid documentary feel. STRICTLY NO AI-generated look, " +
  "NO 3D render, NO surreal cartoonish style, NO readable text on any screen " +
  "(UI elements blurred or out of focus). Just a high-quality realistic iPhone photo.";

const STYLE_ANCHOR = process.env.GEMINI_IMAGE_STYLE_ANCHOR ?? DEFAULT_STYLE_ANCHOR;

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY non settata. Aggiungila a reel-engine/.env (è in ~/Documents/AI-Clienti-Config/env.sh)."
    );
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export interface GenerateKeyframeOptions {
  /**
   * Reference image as Buffer (es. da fetchPinterestReference()). Passata
   * come multimodal input insieme al prompt. Quando presente, Gemini la usa
   * come reference compositiva (NON la copia letteralmente).
   */
  referenceBuffer?: Buffer;
  referenceMimeType?: "image/png" | "image/jpeg" | "image/webp";
  /**
   * Multiple reference images (es. scene multi-personaggio: sheet di 2+ character
   * passati insieme). Ognuna col proprio mime. Si sommano al referenceBuffer singolo.
   */
  referenceImages?: Array<{ buffer: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
  /**
   * Output PNG path (assoluto o relativo al cwd).
   */
  outputPath: string;
  /**
   * Append the global style anchor al prompt. Default: true. Disabilita se
   * il caller's prompt contiene già direttive di stile esplicite.
   */
  appendStyleAnchor?: boolean;
}

/**
 * Genera un keyframe PNG e lo salva al path indicato.
 * Lancia errore se Gemini non restituisce immagine dopo 1 retry.
 */
export async function generateKeyframe(
  prompt: string,
  options: GenerateKeyframeOptions
): Promise<void> {
  const fullPrompt =
    options.appendStyleAnchor === false
      ? prompt
      : `${prompt.trim()}\n\n${STYLE_ANCHOR}`;

  const parts: Part[] = [{ text: fullPrompt }];
  if (options.referenceBuffer) {
    parts.push({
      inlineData: {
        mimeType: options.referenceMimeType ?? "image/jpeg",
        data: options.referenceBuffer.toString("base64"),
      },
    });
  }
  if (options.referenceImages) {
    for (const img of options.referenceImages) {
      parts.push({
        inlineData: { mimeType: img.mimeType, data: img.buffer.toString("base64") },
      });
    }
  }

  const tryOnce = async (): Promise<Buffer | null> => {
    const response = await client().models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseModalities: ["IMAGE"] },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) return null;

    for (const part of candidate.content.parts) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, "base64");
      }
    }
    return null;
  };

  let imageBuffer: Buffer | null = null;
  try {
    imageBuffer = await tryOnce();
  } catch (err) {
    // 1 retry con leggero delay (rate limit / 5xx transient)
    await new Promise((r) => setTimeout(r, 2000));
    imageBuffer = await tryOnce();
  }

  if (!imageBuffer) {
    throw new Error(
      `Gemini ${DEFAULT_MODEL}: nessuna immagine restituita per il prompt. ` +
        `Verifica che il modello sia accessibile e che il prompt non sia stato filtrato.`
    );
  }

  await writeFile(options.outputPath, imageBuffer);
}

export function imageModelInUse(): string {
  return DEFAULT_MODEL;
}
