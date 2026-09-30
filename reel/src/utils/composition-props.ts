import type { ReelScript } from "../schemas/script.js";

/**
 * Builder centralizzato dei props della composition Remotion (BasicReel).
 *
 * Centralizzato qui per evitare la divergenza tra `pipeline.ts` (path
 * principale) e `recalc-props.ts` (re-sync manuale dopo edit dello script).
 * Bug riscontrato 2026-05-26: recalc-props perdeva `kineticDashboard` perché
 * mappava i campi a mano e quando il campo è stato aggiunto allo schema
 * nessuno ha aggiornato anche recalc-props → blank screen nelle 3 dashboard
 * scenes del reel un-reel-cliente.
 *
 * Vedi [[feedback_use_existing_helpers]] + [[feedback_memory_into_tools]] —
 * il workaround "ricordarsi di aggiornare entrambi" è stato sostituito dal
 * fix strutturale: questa funzione legge i campi dallo script come opaque
 * struct, niente cherry-picking per campo. Quando si aggiungono nuovi campi
 * scena (es. futuri `kineticChart`, `kineticTimeline`) basta esporli nel
 * tipo `SceneProps` e nel `pick` qui sotto.
 */

export interface SceneProps {
  text: string;
  videoUrl: string | undefined;
  imageUrl?: string;
  kinetic?: ReelScript["scenes"][number]["kinetic"];
  kineticDashboard?: ReelScript["scenes"][number]["kineticDashboard"];
  dashboardComponent?: string;
  typo?: ReelScript["scenes"][number]["typo"];
  kenBurnsRange?: [number, number];
  hideSubtitle?: boolean;
  nameplate?: string;
  nameplateWindow?: [number, number];
  durationInFrames: number;
}

export interface SubtitleWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

/**
 * Converte i word-timestamps ElevenLabs (sec) in SubtitleWord (frame) per il
 * componente Remotion `Subtitle`. Pulisce il testo da audio tag inline
 * (es. `[serious tone]`, `[contemplative]`) e applica un lead time per
 * compensare il bias dei timestamp ElevenLabs (~80ms): il modello marca lo
 * startSec come fine del fonema iniziale, non come onset acustico → highlight
 * appare percettivamente in ritardo. leadSec positivo anticipa il sub.
 */
export function buildSubtitleWords(
  words: { word: string; startSec: number; endSec: number }[],
  fps: number,
  leadSec: number = 0.1
): SubtitleWord[] {
  return words
    // Rimuovi i token degli Audio Tags v3. NON solo i tag a token singolo
    // ("[warm]"): i tag multi-parola arrivano spezzati ("[serious" + "tone]"),
    // quindi filtra qualunque token che contenga una parentesi quadra (nessuna
    // parola reale di sottotitolo ne contiene). Fix 2026-06-07 ([serious tone]
    // trapelato nei sottotitoli del reel un cliente).
    .filter((w) => !/[[\]]/.test(w.word.trim()))
    .map((w) => ({
      text: w.word,
      startFrame: Math.max(0, Math.round((w.startSec - leadSec) * fps)),
      endFrame: Math.max(0, Math.round((w.endSec - leadSec) * fps)),
    }));
}

/**
 * Mappa una scena dello script in props per la composition. Centralizzato
 * per evitare drift tra i path (pipeline main vs recalc-props).
 */
function sceneToProps(
  scene: ReelScript["scenes"][number],
  videoUrl: string | undefined,
  durationInFrames: number
): SceneProps {
  return {
    text: scene.text,
    videoUrl,
    imageUrl: scene.imageUrl,
    kinetic: scene.kinetic,
    kineticDashboard: scene.kineticDashboard,
    dashboardComponent: scene.dashboardComponent,
    typo: scene.typo,
    kenBurnsRange: scene.kenBurnsRange,
    // Le scene SPLICE (sourceClip) hanno i sottotitoli impressi nel footage
    // originale → sopprimi il sottotitolo globale di default (override esplicito
    // con hideSubtitle:false se lo spezzone è senza caption).
    hideSubtitle: scene.hideSubtitle ?? (scene.sourceClip ? true : undefined),
    nameplate: scene.nameplate,
    nameplateWindow: scene.nameplateWindow,
    durationInFrames,
  };
}

export function buildScenesProps(
  script: ReelScript,
  sceneVideos: (string | undefined)[],
  scaledFrames: number[]
): SceneProps[] {
  return script.scenes.map((s, i) =>
    sceneToProps(s, sceneVideos[i] || undefined, scaledFrames[i])
  );
}

export interface CompositionPropsFull {
  hook: string;
  scenes: SceneProps[];
  cta: string;
  voiceoverUrl?: string;
  subtitles?: SubtitleWord[];
  subtitleStyle?: ReelScript["subtitleStyle"];
  musicBeats?: number[];
}

/**
 * Builder completo del payload composition-props (BasicReel + scene props +
 * cta + voiceoverUrl + subtitles). I caller (pipeline.ts, recalc-props.ts) lo
 * scrivono su disco insieme a `compositionId` e `durationInFrames`.
 */
export function buildCompositionProps(
  script: ReelScript,
  sceneVideos: (string | undefined)[],
  scaledFrames: number[],
  voiceoverUrl: string | undefined,
  subtitles?: SubtitleWord[]
): CompositionPropsFull {
  return {
    hook: script.hook,
    scenes: buildScenesProps(script, sceneVideos, scaledFrames),
    cta: script.cta,
    voiceoverUrl,
    subtitles,
    subtitleStyle: script.subtitleStyle,
    musicBeats: script.musicBeats,
  };
}
