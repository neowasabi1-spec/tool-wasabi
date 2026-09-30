/**
 * Gemini vision client specializzato per face/character consistency check.
 *
 * Input: 1 keyframe canonical + 1 candidate frame estratto da un video Kling i2v.
 * Output: 4 score (faccia, capelli, outfit, overall) + issues + verdict.
 *
 * Diverso da gemini-vision.ts (che valuta adherence a un visualPrompt): qui
 * valutiamo IDENTITY MATCH tra due immagini dello stesso character.
 *
 * Default model: gemini-3.1-pro-preview (multimodal flagship, judgment sottile
 * su differenze facciali). Override via env GEMINI_VISION_MODEL (condiviso con
 * gemini-vision.ts).
 *
 * Costo per check: ~$0.02-0.04. Per test 6 character × 3 variations × 2 frame
 * = 36 check ≈ $1.20.
 */
import { readFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-3.1-pro-preview";

export interface ConsistencyVerdict {
  facialIdentity: number;
  hairStyle: number;
  outfit: number;
  overall: number;
  observed: string;
  issues: string[];
  verdict: "match" | "borderline" | "drift";
}

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

const SYSTEM_INSTRUCTION = `Sei un casting director esperto che valuta CHARACTER CONSISTENCY tra una immagine REFERENCE (keyframe canonical di un personaggio) e una immagine CANDIDATE (frame estratto da un video generato AI partendo dallo stesso keyframe).

Il tuo unico compito: dire se il character nel CANDIDATE è LO STESSO INDIVIDUO del REFERENCE, o se il modello generativo ha "driftato" producendo una persona percepibilmente diversa.

VALUTA 4 DIMENSIONI in modo INDIPENDENTE:

1. facialIdentity (1-10) — è la STESSA PERSONA?
   - Struttura ossea (mascella, zigomi, naso, fronte)
   - Distanza occhi, forma occhi, sopracciglia
   - Forma bocca e labbra
   - Età percepita, etnia percepita, gender
   - 10 = identica persona, riconoscibile a colpo d'occhio
   - 7-9 = stessa persona ma con piccole varianti (espressione, angolo)
   - 4-6 = forse stessa persona, ma uno spettatore casuale potrebbe dubitare
   - 1-3 = chiaramente persona diversa

2. hairStyle (1-10) — capelli coerenti?
   - Stesso colore, stessa lunghezza, stesso volume, stesso styling
   - Permettere micro-varianti dovute a movimento, NON cambio di taglio

3. outfit (1-10) — vestiti coerenti?
   - Stessi capi, stessi colori, stessi accessori (orecchini, collane)
   - Permettere variazioni di angolo/illuminazione, NON cambio di guardaroba

4. overall (1-10) — verdict olistico
   - Tiene conto di TUTTO sopra ma è una giudizio singolo finale
   - 10 = il character è perfettamente coerente, il reel funziona
   - 7-9 = drift accettabile, viewer non se ne accorge
   - 5-6 = borderline, percepibile a chi guarda con attenzione
   - 1-4 = drift bloccante, il character cambia visibilmente

REGOLE verdict:
- "match" = overall ≥ 8
- "borderline" = overall 5-7
- "drift" = overall ≤ 4

Output rigorosamente in JSON con questa shape (nessun testo prima o dopo):
{
  "facialIdentity": 8,
  "hairStyle": 9,
  "outfit": 7,
  "overall": 8,
  "observed": "Frase 1. Frase 2. Massimo 3 frasi che descrivono cosa hai osservato nel candidate vs reference.",
  "issues": ["issue specifico 1", "issue specifico 2"],
  "verdict": "match" | "borderline" | "drift"
}

Sii SEVERO ma onesto. Per un reel pubblicabile, il character DEVE essere riconoscibilmente la stessa persona su tutte le scene. Drift facciale = reel non pubblicabile.`;

async function fileToBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}

export async function compareConsistency(
  referencePath: string,
  candidatePath: string,
  characterLabel: string
): Promise<ConsistencyVerdict> {
  const [refB64, candB64] = await Promise.all([
    fileToBase64(referencePath),
    fileToBase64(candidatePath),
  ]);

  const userParts = [
    {
      text: `CHARACTER: "${characterLabel}"\n\nReference (keyframe canonical) e candidate (frame estratto da video Kling i2v) sotto. Valuta consistency secondo le regole del sistema.\n\nIMMAGINE 1 = REFERENCE\nIMMAGINE 2 = CANDIDATE`,
    },
    { inlineData: { mimeType: "image/png", data: refB64 } },
    { inlineData: { mimeType: "image/png", data: candB64 } },
  ];

  const tryOnce = async (): Promise<ConsistencyVerdict> => {
    const response = await client().models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: "user", parts: userParts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const raw = response.text ?? "";
    if (!raw.trim()) throw new Error("Gemini risposta vuota");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Gemini JSON non trovato: ${raw.slice(0, 200)}`);
      parsed = JSON.parse(match[0]);
    }

    return validateVerdict(parsed);
  };

  try {
    return await tryOnce();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return await tryOnce();
  }
}

function clamp(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

function validateVerdict(obj: unknown): ConsistencyVerdict {
  if (!obj || typeof obj !== "object") throw new Error("Verdict non oggetto");
  const o = obj as Record<string, unknown>;
  const facialIdentity = clamp(typeof o.facialIdentity === "number" ? o.facialIdentity : 0);
  const hairStyle = clamp(typeof o.hairStyle === "number" ? o.hairStyle : 0);
  const outfit = clamp(typeof o.outfit === "number" ? o.outfit : 0);
  const overall = clamp(typeof o.overall === "number" ? o.overall : 0);
  const observed = typeof o.observed === "string" ? o.observed : "";
  const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string") : [];
  const verdict =
    o.verdict === "match" || o.verdict === "borderline" || o.verdict === "drift"
      ? o.verdict
      : overall >= 8
      ? "match"
      : overall >= 5
      ? "borderline"
      : "drift";

  if (!observed) throw new Error("Verdict 'observed' vuoto");
  return { facialIdentity, hairStyle, outfit, overall, observed, issues, verdict };
}

export function consistencyModelInUse(): string {
  return DEFAULT_MODEL;
}
