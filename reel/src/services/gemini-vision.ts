/**
 * Gemini vision client per scene-map L2: valuta se un clip Kling rispetta il
 * visualPrompt fornito. Input: 2 frame (first + mid) + prompt → Output:
 * descrizione osservata + voto aderenza (1-10) + lista issue.
 *
 * Default model: gemini-3.1-pro (multimodal flagship, judgment sottile).
 * Override via env GEMINI_VISION_MODEL.
 *
 * Costo stimato per reel da 30 scene con Pro: ~$0.40-0.80. Per chi vuole
 * risparmiare, passare gemini-3.1-flash via env (~$0.05-0.08/reel).
 */
import { readFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-3.1-pro-preview";

export interface SceneVisionVerdict {
  observed: string;       // Descrizione di cosa il modello vede davvero (2-3 frasi)
  adherence: number;      // 1-10 quanto il clip rispetta il visualPrompt
  issues: string[];       // Lista breve di problemi specifici (artefatti, palette off, camera diversa, etc.)
  verdict: "ok" | "borderline" | "rigenerare";
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

const SYSTEM_INSTRUCTION = `Sei un direttore della fotografia esperto che valuta clip video AI-generated (Kling 3.0) per produzioni copy DR italiane.

Il tuo compito: confrontare il visual_prompt richiesto con i 2 frame estratti dal clip (first frame + mid frame) e giudicare se il clip rispetta il brief.

Cose CRITICHE da valutare (in ordine di severità):
1. SOGGETTO E AMBIENTE — la scena mostra il soggetto giusto nell'ambiente giusto? Manca un elemento chiave?
2. CAMERA MOVEMENT — il prompt chiede dolly-in, pan, static, etc. Si percepisce il movimento corretto fra first→mid frame? Un "dolly-in" che resta statico è un fail.
3. ARTEFATTI FACCIALI — volti distorti, occhi storti, denti deformi, mani con dita extra. Bloccante.
4. TESTO ILLEGIBILE — se ci sono schermi/documenti/insegne nel frame, contengono testo distorto o pseudo-leggibile? Anche questo è bloccante per il brand.
5. LIGHTING E PALETTE — la luce è coerente col prompt (golden hour, cold blue, etc.)? I colori sono nella palette HEX richiesta?
6. DEPTH OF FIELD — il prompt chiede shallow DOF (f/1.8) ed è ottenuto? Tutto a fuoco quando dovrebbe essere blur = fail estetico.

Output rigorosamente in JSON con questa shape (nessun testo prima o dopo):
{
  "observed": "Frase 1. Frase 2. Massimo 3 frasi che descrivono cosa il clip mostra effettivamente.",
  "adherence": 7,
  "issues": ["issue specifico 1", "issue specifico 2"],
  "verdict": "ok" | "borderline" | "rigenerare"
}

Regole verdict:
- "ok" = adherence 8-10, nessun issue bloccante
- "borderline" = adherence 5-7, issue minori ma usabile
- "rigenerare" = adherence 1-4, OR un solo issue bloccante (volto distorto, testo illegibile dominante, soggetto sbagliato, camera totalmente statica quando richiesta in movimento)

Sii severo ma onesto. Un clip che non rispetta il prompt costa una rigenerazione da $0.50 — il falso positivo è più costoso del falso negativo.`;

async function fileToBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}

/**
 * Analizza un singolo clip Kling (rappresentato da 2-3 frame) vs visualPrompt.
 * Ritorna un verdict strutturato. Lancia errore se Gemini risponde malformato
 * dopo 1 retry — caller deve gestire (es. marcare la scena come "skipped").
 */
export async function analyzeScene(
  visualPrompt: string,
  framePaths: string[]
): Promise<SceneVisionVerdict> {
  if (framePaths.length === 0) {
    throw new Error("analyzeScene: nessun frame fornito");
  }

  const imageParts = await Promise.all(
    framePaths.map(async (p) => ({
      inlineData: {
        mimeType: "image/png",
        data: await fileToBase64(p),
      },
    }))
  );

  const userParts = [
    {
      text: `VISUAL PROMPT richiesto per questo clip:\n\n"""${visualPrompt}"""\n\nSotto trovi ${framePaths.length} frame estratti dal clip generato (${framePaths.length === 2 ? "first frame e mid frame" : "first, mid e last frame"}). Valuta se il clip rispetta il prompt secondo le regole del sistema.`,
    },
    ...imageParts,
  ];

  const tryOnce = async (): Promise<SceneVisionVerdict> => {
    const response = await client().models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: "user", parts: userParts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const raw = response.text ?? "";
    if (!raw.trim()) {
      throw new Error("Gemini ha risposto con stringa vuota");
    }

    // Tenta parse diretto, fallback a estrazione blocco JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Gemini: JSON non trovato in risposta: ${raw.slice(0, 200)}`);
      parsed = JSON.parse(match[0]);
    }

    return validateVerdict(parsed);
  };

  try {
    return await tryOnce();
  } catch (err) {
    // 1 retry con leggero delay (rate limit transienti)
    await new Promise((r) => setTimeout(r, 1500));
    return await tryOnce();
  }
}

function validateVerdict(obj: unknown): SceneVisionVerdict {
  if (!obj || typeof obj !== "object") {
    throw new Error("Verdict: non è un oggetto");
  }
  const o = obj as Record<string, unknown>;
  const observed = typeof o.observed === "string" ? o.observed : "";
  const adherence = typeof o.adherence === "number" ? Math.round(o.adherence) : 0;
  const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === "string") : [];
  const verdict =
    o.verdict === "ok" || o.verdict === "borderline" || o.verdict === "rigenerare"
      ? o.verdict
      : adherence >= 8
      ? "ok"
      : adherence >= 5
      ? "borderline"
      : "rigenerare";

  if (!observed) throw new Error("Verdict: campo 'observed' vuoto");
  if (adherence < 1 || adherence > 10) {
    throw new Error(`Verdict: 'adherence' fuori range (${adherence})`);
  }

  return { observed, adherence, issues, verdict };
}

export function visionModelInUse(): string {
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// REFRESH CREATIVO — deconstruct (verdetto riproducibilità) + verify (GATE V)
// ---------------------------------------------------------------------------

/** Esegue una generateContent JSON-mode con 1 retry su risposta vuota/malformata. */
async function runVisionJson(
  systemInstruction: string,
  userParts: unknown[]
): Promise<Record<string, unknown>> {
  const once = async (): Promise<Record<string, unknown>> => {
    const response = await client().models.generateContent({
      model: DEFAULT_MODEL,
      contents: [{ role: "user", parts: userParts as never }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });
    const raw = response.text ?? "";
    if (!raw.trim()) throw new Error("Gemini ha risposto con stringa vuota");
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Gemini: JSON non trovato: ${raw.slice(0, 200)}`);
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  };
  try {
    return await once();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return await once();
  }
}

export interface ShotDeconstructResult {
  subject: string;
  setting: string;
  motion: string;
  onScreenText: string;
  hasReadableText: boolean;
  hasLogoOrUI: boolean;
  isProductWithText: boolean;
  isTalkingHead: boolean;
  isBeforeAfter: boolean;
  verdict: "ai-recreate" | "static-png" | "card" | "splice";
  rationale: string;
  confidence: number;
}

const DECONSTRUCT_SYSTEM_INSTRUCTION = `Sei un direttore creativo che deve CLONARE una video-ad performante ricreandola con l'AI dove possibile e recuperando spezzoni dell'originale dove l'AI non regge.

Ti do UN frame rappresentativo di uno shot, più il voiceover che ci scorre sopra. Devi classificare lo shot e proporre COME va ricreato nel nuovo reel.

Regole dei modelli video AI (Kling 3.0) che devi rispettare:
- Rendono SEMPRE male: testo leggibile, loghi, numeri, UI di app, schermi con dati, packaging con scritte, codici a barre. Se lo shot DIPENDE da uno di questi → NON è "ai-recreate".
- Un volto umano che PARLA in sync col voiceover non è ricreabile fedele (lip-sync + identità) → "splice".
- Un before/after dove la STESSA persona deve combaciare → "splice".

Scegli UN verdetto fra esattamente questi 4:
- "ai-recreate" → oggetto/atmosfera/gesto SENZA testo leggibile e SENZA identità specifica da preservare (es. macro di labbra generiche, goccia di siero, ingrediente naturale, b-roll ambientale). Questi li ricreiamo con keyframe + image-to-video.
- "static-png" → prodotto/pack-shot con scritte dove ESISTE quasi certamente un asset brand pulito da usare come immagine statica con micro-zoom. Scegli questo SOLO se è un prodotto fotografato "da catalogo" (packaging, flacone, scatola).
- "card" → grafica/overlay informativo: badge, recensioni/stelle, garanzia, prezzo, QR, CTA, dashboard/KPI, claim a schermo. Lo ricostruiamo come componente grafico nitido.
- "splice" → tutto ciò che va RECUPERATO verbatim dall'originale: talking-head, before/after con identità, dimostrazioni di prodotto difficili, qualsiasi shot la cui resa AI sarebbe inferiore all'originale.

In caso di dubbio fra ai-recreate e splice su qualcosa che coinvolge un volto, identità, o testo → scegli "splice" (recuperare è più sicuro che sbagliare).

Output rigorosamente JSON (nessun testo prima/dopo), shape:
{
  "subject": "cosa è inquadrato",
  "setting": "ambiente",
  "motion": "movimento camera + soggetto",
  "onScreenText": "testo a schermo letto VERBATIM, '' se nessuno",
  "hasReadableText": true|false,
  "hasLogoOrUI": true|false,
  "isProductWithText": true|false,
  "isTalkingHead": true|false,
  "isBeforeAfter": true|false,
  "verdict": "ai-recreate"|"static-png"|"card"|"splice",
  "rationale": "una riga, perché questo verdetto",
  "confidence": 0.0-1.0
}`;

/**
 * Analizza UN frame di uno shot dell'ad originale e propone il verdetto di
 * riproducibilità + i flag (testo/logo/talking-head/before-after). È una
 * PROPOSTA: l'umano la conferma alla TABELLA SCENE. Lancia dopo 1 retry.
 */
export async function analyzeShotForDeconstruct(
  framePath: string,
  ctx: { vo?: string; durationSec?: number }
): Promise<ShotDeconstructResult> {
  const userParts = [
    {
      text:
        `Voiceover su questo shot: "${ctx.vo?.trim() || "(nessun parlato)"}"\n` +
        `Durata shot: ${ctx.durationSec?.toFixed(1) ?? "?"}s\n\n` +
        `Sotto: il frame rappresentativo. Classifica e proponi il verdetto secondo le regole.`,
    },
    { inlineData: { mimeType: "image/png", data: await fileToBase64(framePath) } },
  ];
  const o = await runVisionJson(DECONSTRUCT_SYSTEM_INSTRUCTION, userParts);
  const allowed = ["ai-recreate", "static-png", "card", "splice"] as const;
  const verdict = (allowed as readonly string[]).includes(String(o.verdict))
    ? (o.verdict as ShotDeconstructResult["verdict"])
    : "splice"; // default difensivo
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const bool = (k: string) => o[k] === true;
  const conf = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
  return {
    subject: str("subject"),
    setting: str("setting"),
    motion: str("motion"),
    onScreenText: str("onScreenText"),
    hasReadableText: bool("hasReadableText"),
    hasLogoOrUI: bool("hasLogoOrUI"),
    isProductWithText: bool("isProductWithText"),
    isTalkingHead: bool("isTalkingHead"),
    isBeforeAfter: bool("isBeforeAfter"),
    verdict,
    rationale: str("rationale"),
    confidence: conf,
  };
}

const SUBJECT_MATCH_SYSTEM_INSTRUCTION = `Sei un QA severo di una pipeline video. Ti do DUE immagini:
1) il KEYFRAME approvato (cosa la scena DOVEVA essere)
2) il PRIMO FRAME del clip generato (cosa è uscito)

Devi dire se il clip rappresenta LO STESSO soggetto del keyframe. È un controllo anti-regressione: serve a beccare il caso in cui il generatore ha prodotto un soggetto/persona/oggetto DIVERSO da quello approvato (es. keyframe = labbra di donna, clip = volto di uomo).

Considera MATCH=false (severo) se:
- persona diversa, genere diverso, età molto diversa
- oggetto principale diverso (es. labbra vs occhio, flacone vs scatola)
- composizione/inquadratura stravolta
- è comparso testo/codice/logo grafico NON presente nel keyframe
NON penalizzare: micro-movimento, leggero cambio di luce, lieve push-in — sono attesi nell'image-to-video.

Output JSON: { "match": true|false, "score": 0-10, "reason": "una riga" }
score 8-10 = stesso soggetto; 5-7 = dubbio; 0-4 = soggetto diverso.`;

/**
 * GATE V — confronta il keyframe approvato col primo frame del clip generato e
 * dice se il soggetto combacia. Beccava il fallimento un brand cliente v2 (keyframe
 * labbra di donna → clip volto d'uomo + codice a barre).
 */
export async function subjectMatch(
  keyframePath: string,
  clipFramePath: string
): Promise<{ match: boolean; score: number; reason: string }> {
  const userParts = [
    { text: "Immagine 1 = KEYFRAME approvato. Immagine 2 = primo frame del clip generato. Combaciano nel soggetto?" },
    { inlineData: { mimeType: "image/png", data: await fileToBase64(keyframePath) } },
    { inlineData: { mimeType: "image/png", data: await fileToBase64(clipFramePath) } },
  ];
  const o = await runVisionJson(SUBJECT_MATCH_SYSTEM_INSTRUCTION, userParts);
  const score = typeof o.score === "number" ? Math.max(0, Math.min(10, o.score)) : 0;
  const match = o.match === true && score >= 5;
  const reason = typeof o.reason === "string" ? o.reason : "";
  return { match, score, reason };
}
