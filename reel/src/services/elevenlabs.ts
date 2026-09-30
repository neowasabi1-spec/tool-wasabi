import { writeFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const BASE_URL = "https://api.elevenlabs.io/v1";

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

export interface TTSResult {
  audioPath: string;
  durationSec: number;
  words: WordTimestamp[];
}

async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    filePath,
  ]);
  const info = JSON.parse(stdout);
  return parseFloat(info.format.duration);
}

/**
 * Converte i character-level timestamps di ElevenLabs in word-level timestamps.
 * Raggruppa i caratteri tra spazi per formare parole con start/end time.
 */
function charactersToWords(
  characters: string[],
  startTimes: number[],
  endTimes: number[]
): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let currentWord = "";
  let wordStart = -1;
  let wordEnd = -1;

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];

    if (char === " " || char === "\n" || char === "\t") {
      // Fine parola — salva se non vuota
      if (currentWord.length > 0) {
        words.push({ word: currentWord, startSec: wordStart, endSec: wordEnd });
        currentWord = "";
        wordStart = -1;
        wordEnd = -1;
      }
    } else {
      if (currentWord.length === 0) {
        wordStart = startTimes[i];
      }
      currentWord += char;
      wordEnd = endTimes[i];
    }
  }

  // Ultima parola
  if (currentWord.length > 0) {
    words.push({ word: currentWord, startSec: wordStart, endSec: wordEnd });
  }

  return words;
}

export async function generateVoiceover(
  text: string,
  outputPath: string,
  options?: {
    voiceId?: string;
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
  }
): Promise<TTSResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set in .env");

  const voiceId =
    options?.voiceId ??
    process.env.ELEVENLABS_VOICE_ID ??
    "TX3LPaxmHKxFdv7VOQHJ";

  const response = await fetch(
    `${BASE_URL}/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: options?.modelId ?? "eleven_v3",
        output_format: "mp3_44100_192",
        // BUG FIX 2026-05-27: `speed` deve stare DENTRO voice_settings, non top-level.
        // Prima il parametro era ignorato dall'API ElevenLabs (validato sul reel un-reel-cliente).
        voice_settings: {
          stability: options?.stability ?? 0.70,
          similarity_boost: options?.similarityBoost ?? 0.85,
          style: options?.style ?? 0.35,
          use_speaker_boost: options?.useSpeakerBoost ?? true,
          speed: options?.speed ?? 1.15,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${error}`);
  }

  const json = await response.json() as {
    audio_base64: string;
    alignment: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  // Decodifica audio base64 e salva
  const audioBuffer = Buffer.from(json.audio_base64, "base64");
  await writeFile(outputPath, audioBuffer);

  // Converti character timestamps in word timestamps
  const words = charactersToWords(
    json.alignment.characters,
    json.alignment.character_start_times_seconds,
    json.alignment.character_end_times_seconds
  );

  const durationSec = await getAudioDuration(outputPath);

  return { audioPath: outputPath, durationSec, words };
}

// ---------------------------------------------------------------------------
// Multi-voice (dialogue) TTS
// ---------------------------------------------------------------------------

export interface VoiceoverSegmentInput {
  voiceId: string;
  text: string;
  speaker?: string;
  modelId?: string;
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
  };
  silenceAfterMs?: number;
}

/**
 * Genera un voiceover multi-voce concatenando N segmenti TTS, ognuno con il
 * proprio voiceId. Restituisce un singolo file audio + word timestamps con
 * gli offset cumulativi corretti rispetto al file finale.
 *
 * Use case: dialoghi a 2+ personaggi nello stesso reel (es. talking cats).
 *
 * Strategia:
 *  1. Per ogni segmento → chiamata ElevenLabs separata, salvata in temp file
 *  2. Per ogni segmento → word timestamps offsetate dalla durata cumulativa
 *  3. Concatenazione con ffmpeg concat demuxer (no re-encode, veloce)
 *  4. Cleanup dei temp file
 */
/**
 * Genera un breve file mp3 di silenzio con lo stesso encoding dei segmenti voce
 * ElevenLabs (mp3 44100Hz MONO, 192kbps). Usato per inserire pause naturali fra
 * battute di dialogo.
 *
 * IMPORTANTE: ElevenLabs restituisce MONO. Se generassimo silence stereo,
 * il concat di ffmpeg con `-c copy` produrrebbe un file con frame alternati
 * mono/stereo che alcuni player interpretano come tracce separate.
 * Bug riscontrato e corretto il 2026-04-06.
 */
async function generateSilenceMp3(
  durationMs: number,
  outputPath: string
): Promise<void> {
  const seconds = (durationMs / 1000).toFixed(3);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=44100",
    "-t",
    seconds,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ac",
    "1",
    outputPath,
  ]);
}

export async function generateVoiceoverMulti(
  segments: VoiceoverSegmentInput[],
  outputPath: string,
  options?: {
    defaultModelId?: string;
    /** Default voice settings ereditati da tutti i segmenti che non li overridano */
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    speed?: number;
    /**
     * Pausa di default fra un segmento e il successivo (millisecondi).
     * Default 350ms — abbastanza per dare respiro a un dialogo senza spezzare il ritmo.
     * Può essere overridata per segmento con `seg.silenceAfterMs`.
     * Imposta a 0 per disabilitare globalmente.
     */
    defaultSilenceMs?: number;
  }
): Promise<TTSResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set in .env");

  if (segments.length === 0) {
    throw new Error("generateVoiceoverMulti: nessun segmento fornito");
  }

  const defaultSilenceMs = options?.defaultSilenceMs ?? 350;

  // Temp dir per i segmenti intermedi
  const outDir = dirname(outputPath);
  const tmpDir = join(outDir, ".tts-segments");
  await mkdir(tmpDir, { recursive: true });

  const allWords: WordTimestamp[] = [];
  const concatList: string[] = []; // Path ordinati di tutti i file da concatenare (segmenti + silence)
  let cumulativeOffset = 0;

  // Cache dei file silence per durata (evita di rigenerare lo stesso file più volte)
  const silenceCache = new Map<number, string>();
  const getSilencePath = async (ms: number): Promise<string> => {
    if (silenceCache.has(ms)) return silenceCache.get(ms)!;
    const silPath = join(tmpDir, `silence-${ms}ms.mp3`);
    await generateSilenceMp3(ms, silPath);
    silenceCache.set(ms, silPath);
    return silPath;
  };

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segPath = join(tmpDir, `seg-${String(i + 1).padStart(3, "0")}.mp3`);

      const modelId = seg.modelId ?? options?.defaultModelId ?? "eleven_v3";
      const speakerLabel = seg.speaker ? `${seg.speaker}` : `seg ${i + 1}`;
      console.log(
        `   🎙️  [${i + 1}/${segments.length}] ${speakerLabel} (${seg.voiceId.slice(0, 8)}…) — "${seg.text.slice(0, 40)}…"`
      );

      // Voice settings: per-segmento override → option default → hardcoded default
      const stability =
        seg.voiceSettings?.stability ?? options?.stability ?? 0.40;
      const similarityBoost =
        seg.voiceSettings?.similarityBoost ?? options?.similarityBoost ?? 0.85;
      const style = seg.voiceSettings?.style ?? options?.style ?? 0.55;
      const useSpeakerBoost =
        seg.voiceSettings?.useSpeakerBoost ?? options?.useSpeakerBoost ?? true;
      const speed = seg.voiceSettings?.speed ?? options?.speed ?? 1.0;

      const response = await fetch(
        `${BASE_URL}/text-to-speech/${seg.voiceId}/with-timestamps`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: seg.text,
            model_id: modelId,
            output_format: "mp3_44100_192",
            speed,
            voice_settings: {
              stability,
              similarity_boost: similarityBoost,
              style,
              use_speaker_boost: useSpeakerBoost,
            },
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `ElevenLabs TTS failed (segment ${i + 1}/${segments.length}): ${response.status} ${error}`
        );
      }

      const json = (await response.json()) as {
        audio_base64: string;
        alignment: {
          characters: string[];
          character_start_times_seconds: number[];
          character_end_times_seconds: number[];
        };
      };

      const audioBuffer = Buffer.from(json.audio_base64, "base64");
      await writeFile(segPath, audioBuffer);
      concatList.push(segPath);

      // Word timestamps di QUESTO segmento, offsetati dalla durata cumulativa
      const segWords = charactersToWords(
        json.alignment.characters,
        json.alignment.character_start_times_seconds,
        json.alignment.character_end_times_seconds
      );
      for (const w of segWords) {
        allWords.push({
          word: w.word,
          startSec: w.startSec + cumulativeOffset,
          endSec: w.endSec + cumulativeOffset,
        });
      }

      // Aggiorna l'offset per il prossimo segmento usando la durata REALE del file
      const segDuration = await getAudioDuration(segPath);
      cumulativeOffset += segDuration;

      // Inserisci silenzio interstiziale (se non è l'ultimo segmento)
      const isLast = i === segments.length - 1;
      if (!isLast) {
        const silenceMs = seg.silenceAfterMs ?? defaultSilenceMs;
        if (silenceMs > 0) {
          const silPath = await getSilencePath(silenceMs);
          concatList.push(silPath);
          cumulativeOffset += silenceMs / 1000;
        }
      }
    }

    // Concatena tutti i file (segmenti + silence) con ffmpeg concat FILTER
    // (non concat demuxer + -c copy). Il filter ricodifica una sola volta
    // alla fine, producendo un MP3 mono CBR 192k completamente uniforme.
    //
    // Perché non `-c copy`: ElevenLabs restituisce MP3 con header sottilmente
    // diversi run-by-run (VBR vs CBR, channel layout flag), e anche tra segmenti
    // diversi. Il `-c copy` su file con header non identici produce un singolo
    // file con frame eterogenei che alcuni player (Finder Quick Look, alcuni
    // browser) interpretano come tracce separate, costringendo l'utente a
    // cliccare per passare da un segmento all'altro. Il concat filter risolve
    // ricodificando tutto in un unico stream MP3 omogeneo (~200ms di costo
    // CPU per minuto di audio — trascurabile).
    //
    // Bug originale: 2026-04-06 reel-4602 (talking cats Infobusiness Milionario).
    const inputArgs: string[] = [];
    for (const p of concatList) {
      inputArgs.push("-i", p);
    }
    const filterParts = concatList.map((_, i) => `[${i}:a]`).join("");
    const filterComplex = `${filterParts}concat=n=${concatList.length}:v=0:a=1[out]`;

    await execFileAsync("ffmpeg", [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-ar",
      "44100",
      "-ac",
      "1",
      outputPath,
    ]);

    const totalDuration = await getAudioDuration(outputPath);

    return {
      audioPath: outputPath,
      durationSec: totalDuration,
      words: allWords,
    };
  } catch (err) {
    // Su errore, cleanup totale per evitare di lasciare segmenti corrotti
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // NB: in caso di successo NON cancelliamo .tts-segments/ — mantenere i singoli
  // segmenti permette di ricomporre il voiceover con silenzi diversi (o aggiungere/
  // togliere battute) senza rigenerare gli ElevenLabs. Costo storage trascurabile
  // (~70KB per segmento). Per pulire manualmente: rm -rf assets/.tts-segments
}
