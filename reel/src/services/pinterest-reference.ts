/**
 * Pinterest reference image extractor.
 *
 * Pinterest blocca le pagine dei pin dietro un modal di login forzato per
 * utenti non autenticati. Però la CDN i.pinimg.com è pubblica e l'URL diretto
 * dell'immagine è esposto nei dati strutturati JSON dell'HTML della pagina pin.
 *
 * Pattern (validato 2026-05-27 vedi [[reference-pinterest-image-access]]):
 *   1. curl HTML del pin con User-Agent realistic (obbligatorio)
 *   2. grep per `"image":"https://i.pinimg.com/originals/..."` (campo JSON
 *      dei dati strutturati — più affidabile del grep generico che matcha
 *      placeholder Pinterest condivisi da 4KB)
 *   3. fetch dell'immagine dalla CDN pubblica
 *   4. valida size > 10KB (sotto = placeholder)
 *
 * Usato dallo Stage 1.7 Storyboard per fornire reference compositive a Gemini.
 */

import { Buffer } from "node:buffer";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PINTEREST_URL_REGEX =
  /^https?:\/\/(www\.|it\.|fr\.|es\.|de\.|uk\.|ca\.|au\.|jp\.|in\.|br\.|pt\.|nl\.|se\.|no\.|dk\.|fi\.|pl\.|tr\.|ru\.|kr\.|tw\.|hk\.|mx\.|ar\.|cl\.|co\.|pe\.|ph\.|sg\.|my\.|id\.|th\.|vn\.|cz\.|hu\.|ro\.|gr\.|il\.|ae\.|sa\.|za\.|ng\.|eg\.|ke\.)?pinterest\.[a-z.]+\/pin\//;

const PINIMG_URL_REGEX = /"image":"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/;

const MIN_VALID_SIZE_BYTES = 10 * 1024;

/**
 * Detects if a URL is a Pinterest pin URL (any country subdomain).
 */
export function isPinterestUrl(url: string): boolean {
  return PINTEREST_URL_REGEX.test(url);
}

/**
 * Fetches a Pinterest pin's full-size image as a Buffer.
 *
 * @param pinUrl URL like "https://it.pinterest.com/pin/12345/"
 * @returns Buffer of the original-resolution PNG/JPG, or null if extraction fails
 *          (pin private/deleted/changed HTML structure/placeholder returned).
 *          Callers should fallback gracefully to text-only generation.
 */
export async function fetchPinterestReference(pinUrl: string): Promise<Buffer | null> {
  if (!isPinterestUrl(pinUrl)) {
    return null;
  }

  // Step 1: fetch the pin's HTML with realistic User-Agent
  let html: string;
  try {
    const response = await fetch(pinUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  // Step 2: extract image URL from JSON structured data
  const match = html.match(PINIMG_URL_REGEX);
  if (!match || !match[1]) return null;

  // Step 3: decode JSON escapes and fetch the image
  const imageUrl = match[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");

  let buffer: Buffer;
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) return null;
    const arrayBuffer = await imageResponse.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch {
    return null;
  }

  // Step 4: validate non-placeholder size
  if (buffer.length < MIN_VALID_SIZE_BYTES) return null;

  return buffer;
}

/**
 * Returns the MIME type guessed from the original URL extension.
 * Defaults to "image/jpeg" if unknown.
 */
export function guessPinterestMimeType(buffer: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "image/jpeg";
}
