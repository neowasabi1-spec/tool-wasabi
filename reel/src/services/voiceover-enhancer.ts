/**
 * Voiceover Enhancer — preprocessa il testo del voiceover
 * aggiungendo Audio Tags di ElevenLabs v3 per migliorare
 * intonazione, ritmo e naturalezza.
 *
 * Funziona senza API esterne: analisi rule-based del testo.
 */

interface EnhanceOptions {
  /** Stile narrativo di apertura. Default: "voice-over style" */
  narrativeStyle?:
    | "voice-over style"
    | "cinematic tone"
    | "documentary style"
    | "conversational tone"
    | "storytelling tone";
  /** Inserisci pause tra le frasi. Default: true */
  addPauses?: boolean;
  /** Enfatizza numeri e cifre con MAIUSCOLE. Default: true */
  emphasizeNumbers?: boolean;
  /** Intensità enhancement: quanti tag aggiungere. Default: "medium" */
  intensity?: "light" | "medium" | "heavy";
}

// Pattern emotivi nel copy italiano e inglese
const TENSION_WORDS =
  /\b(attenzione|problema|rischio|pericolo|errore|sbagliato|crisi|crollo|perdere|perdita|paura|danger|risk|warning|crisis|mistake|wrong|fear|lose|collapse)\b/i;
const REVEAL_WORDS =
  /\b(ecco|scopri|segreto|verità|realtà|soluzione|risposta|trucco|here's|secret|truth|reality|solution|answer|trick|reveal|actually|turns out)\b/i;
const EXCITEMENT_WORDS =
  /\b(incredibile|straordinario|assurdo|pazzesco|esplosivo|enorme|amazing|incredible|insane|massive|explosive|mind-blowing|unbelievable|game.?changer)\b/i;
const QUESTION_ENDING = /\?\s*$/;
const BIG_NUMBER = /(?:\$|€|£)?\d[\d.,]*(?:\s*(?:miliardi|milioni|miliardi|billion|million|thousand|mila|%))/i;
const STANDALONE_NUMBER = /(?:\$|€|£)\s?\d[\d.,]+|\d[\d.,]+\s?%/;

/**
 * Analizza una frase e restituisce un eventuale tag emotivo da preporre.
 */
function detectEmotion(sentence: string): string | null {
  if (TENSION_WORDS.test(sentence)) return "[serious tone]";
  if (REVEAL_WORDS.test(sentence)) return "[intrigued]";
  if (EXCITEMENT_WORDS.test(sentence)) return "[excited]";
  if (QUESTION_ENDING.test(sentence)) return "[curious]";
  return null;
}

/**
 * Enfatizza numeri importanti con MAIUSCOLE nel contesto circostante.
 * "$65,000" → "$65,000", ma "65 miliardi" → "SESSANTACINQUE MILIARDI"
 * In pratica: wrappa il numero e la sua unità per dargli peso vocale.
 */
function emphasizeNumbers(sentence: string): string {
  // Enfatizza numeri con valuta o percentuale mettendo enfasi sulla frase
  return sentence.replace(BIG_NUMBER, (match) => match.toUpperCase());
}

/**
 * Normalizza la punteggiatura per migliorare il ritmo vocale.
 */
function normalizePunctuation(text: string): string {
  let result = text;
  // Converti "..." in ellissi tipografica
  result = result.replace(/\.{3}/g, "…");
  // Converti doppio trattino in em-dash
  result = result.replace(/\s--\s/g, " — ");
  result = result.replace(/--/g, "—");
  // Assicura spazio dopo em-dash
  result = result.replace(/—(\S)/g, "— $1");
  return result;
}

/**
 * Splitta il testo in frasi preservando i delimitatori.
 */
function splitSentences(text: string): string[] {
  // Split su punto, punto esclamativo, punto interrogativo, seguiti da spazio o fine testo
  // Preserva anche split su em-dash e ellissi come break points
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.filter((s) => s.trim().length > 0);
}

/**
 * Determina dove inserire pause in base alla posizione nella narrazione.
 * Inserisce pause dopo frasi "pesanti" (lunghe, con numeri, con tensione).
 */
function shouldPauseAfter(
  sentence: string,
  index: number,
  total: number,
  intensity: "light" | "medium" | "heavy"
): string | null {
  const isLong = sentence.length > 120;
  const hasBigNumber = BIG_NUMBER.test(sentence);
  const hasTension = TENSION_WORDS.test(sentence);
  const hasReveal = REVEAL_WORDS.test(sentence);
  const isFirstSentence = index === 0;
  const isLastSentence = index === total - 1;

  // Mai pausa dopo l'ultima frase
  if (isLastSentence) return null;

  // Intensità light: solo dopo frasi con numeri grossi o reveal
  if (intensity === "light") {
    if (hasBigNumber || hasReveal) return "[short pause]";
    return null;
  }

  // Intensità medium: pause strategiche
  if (intensity === "medium") {
    if (isFirstSentence) return "[pause]"; // Pausa dopo la prima frase (hook)
    if (hasBigNumber) return "[pause]";
    if (hasTension || hasReveal) return "[short pause]";
    if (isLong) return "[short pause]";
    return null;
  }

  // Intensità heavy: pause frequenti
  if (hasBigNumber) return "[pause]";
  if (isFirstSentence) return "[pause]";
  if (hasTension || hasReveal) return "[pause]";
  if (isLong) return "[short pause]";
  // In heavy, pausa ogni 2-3 frasi anche se non c'è trigger
  if (index % 2 === 1) return "[short pause]";
  return null;
}

/**
 * Enhancer principale. Prende il voiceoverText plain e restituisce
 * il testo arricchito con Audio Tags v3.
 */
export function enhanceVoiceover(
  text: string,
  options: EnhanceOptions = {}
): string {
  const {
    narrativeStyle = "voice-over style",
    addPauses = true,
    emphasizeNumbers: doEmphasize = true,
    intensity = "medium",
  } = options;

  // Step 1: normalizza punteggiatura
  let processed = normalizePunctuation(text);

  // Step 2: splitta in frasi
  const sentences = splitSentences(processed);

  // Step 3: processa ogni frase
  const enhanced = sentences.map((sentence, i) => {
    let result = sentence;

    // Enfatizza numeri
    if (doEmphasize) {
      result = emphasizeNumbers(result);
    }

    // Aggiungi tag emotivo (solo per intensity medium/heavy, e non su ogni frase)
    if (intensity !== "light") {
      const emotion = detectEmotion(result);
      if (emotion) {
        result = `${emotion} ${result}`;
      }
    }

    // Aggiungi pausa dopo la frase se appropriato
    if (addPauses) {
      const pause = shouldPauseAfter(result, i, sentences.length, intensity);
      if (pause) {
        result = `${result} ${pause}`;
      }
    }

    return result;
  });

  // Step 4: aggiungi tag narrativo di apertura
  const opening = `[${narrativeStyle}]`;
  const body = enhanced.join(" ");

  return `${opening} ${body}`;
}
