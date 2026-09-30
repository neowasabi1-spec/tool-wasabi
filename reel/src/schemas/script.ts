import { z } from "zod";
import { TypoSchema } from "./typo-schema";

export const KineticNumberSchema = z.object({
  value: z.string().describe("Il numero principale, es. '391' o '40-60'. Solo caratteri da pronunciare visivamente."),
  suffix: z.string().optional().describe("Suffisso piccolo dopo il numero, es. '%'. Opzionale."),
  label: z.string().optional().describe("Label sotto il numero (uppercase), es. 'probabilità in più'. Opzionale."),
  source: z.string().optional().describe("Fonte/citazione piccola sotto il label, es. 'VELOCIFY · 3,5M LEAD'. Opzionale."),
  palette: z
    .object({
      bg: z.string().optional(),
      primary: z.string().optional(),
      accent: z.string().optional(),
      label: z.string().optional(),
      source: z.string().optional(),
    })
    .optional()
    .describe("Override colori HEX (bg, primary, accent, label, source). Opzionale — defaults sono un cliente B2B palette gold/ink."),
});

export const KineticDashboardPalette = z
  .object({
    bg: z.string().optional(),
    surface: z.string().optional(),
    surfaceDeep: z.string().optional(),
    primary: z.string().optional(),
    primaryDim: z.string().optional(),
    label: z.string().optional(),
    labelDim: z.string().optional(),
    grid: z.string().optional(),
    divider: z.string().optional(),
  })
  .optional();

const TrendPanelSchema = z.object({
  type: z.literal("trend"),
  title: z.string().describe("Header uppercase del pannello, es. 'CONVERSAZIONI GESTITE'"),
  meta: z.string().optional().describe("Metainfo a destra del header, es. 'ULTIMI 30 GIORNI'"),
  value: z.string().describe("Numero hero, es. '+127' o '-42'. Solo cifre + segno opzionale."),
  suffix: z.string().optional().describe("Suffisso piccolo dopo il numero, es. '%'"),
  subtitle: z.string().optional().describe("Sottotitolo uppercase, es. 'VS. MESE PRECEDENTE'"),
  dataPoints: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe("Array di punti [x, y] in scala 0-100 per la sparkline. Se omesso usa una curva ascendente di default."),
});

const DonutPanelSchema = z.object({
  type: z.literal("donut"),
  title: z.string(),
  meta: z.string().optional(),
  centerValue: z.string().optional().describe("Numero centrale del donut, es. '4'"),
  centerLabel: z.string().optional().describe("Label sotto il numero centrale, es. 'CANALI'"),
  segments: z
    .array(
      z.object({
        label: z.string(),
        value: z.number().positive(),
        color: z.string().optional().describe("HEX color override, altrimenti usa gradient brass"),
      })
    )
    .min(2)
    .max(6),
});

const BarsPanelSchema = z.object({
  type: z.literal("bars"),
  title: z.string(),
  meta: z.string().optional(),
  value: z.string().describe("Numero hero a sinistra del chart"),
  valueLabel: z.string().optional().describe("Label uppercase a destra del numero, es. 'OGGI'"),
  subtitle: z.string().optional().describe("Sottotitolo uppercase, es. 'MEDIA 7GG: 69'"),
  bars: z
    .array(
      z.object({
        label: z.string().describe("Label sotto la barra, es. 'LUN', 'MAR', 'OGGI'"),
        value: z.number(),
      })
    )
    .min(2)
    .max(12),
  highlightIndex: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Indice della barra da evidenziare (brass glow). Default: ultima barra."),
});

export const KineticDashboardPanelSchema = z.discriminatedUnion("type", [
  TrendPanelSchema,
  DonutPanelSchema,
  BarsPanelSchema,
]);

export const KineticDashboardSchema = z.object({
  panels: z
    .array(KineticDashboardPanelSchema)
    .min(1)
    .max(3)
    .describe("1-3 pannelli stacked verticalmente. Su 9:16, 3 pannelli = layout dashboard wall."),
  palette: KineticDashboardPalette.describe(
    "Override colori HEX (bg, surface, surfaceDeep, primary, primaryDim, label, labelDim, grid, divider). Opzionale — defaults sono navy/brass."
  ),
});

export const ReelSceneSchema = z.object({
  text: z.string().describe("Testo overlay per la scena"),
  visualPrompt: z.string().describe("Prompt per generare immagine/video con fal.ai"),
  kinetic: KineticNumberSchema
    .optional()
    .describe(
      "Se presente, la scena viene renderizzata come KineticNumber (componente Remotion) invece che come video AI-generated o TEXT statico. Usare per pattern interrupt numerici hero (es. 391%). Max 1-2 per reel, max ~4s. Quando presente, visualPrompt e text vengono ignorati per questa scena."
    ),
  kineticDashboard: KineticDashboardSchema
    .optional()
    .describe(
      "Se presente, la scena viene renderizzata come KineticDashboard (componente Remotion full-frame con 1-3 pannelli stacked: trend / donut / bars). Usare quando devi mostrare dashboard/KPI/grafici numerici senza farli generare da Kling (che produce sempre testo gibberish negli schermi). Max ~5s per pannello. Quando presente, visualPrompt, text e kinetic vengono ignorati per questa scena."
    ),
  dashboardComponent: z
    .string()
    .optional()
    .describe(
      "ID (kebab-case) di una dashboard BI/CRM ANIMATA bespoke registrata in remotion/components/dashboards/registry.ts (es. 'acme-owner'). Layout complessi (funnel, scheda cliente, inbox, kanban) che KineticDashboard a 1-3 pannelli non copre. Renderizzata full-frame da BasicReel con micro-motion (count-up, reveal staggerato, donut sweep) — nessun Kling, nessun PNG statico, sync col voiceover via durationSec. Quando presente, visualPrompt/text/kinetic/kineticDashboard/imageUrl vengono ignorati e la scena salta Stage 2. Vedi recipe in CLAUDE.md → 'Dashboard animate'."
    ),
  typo: TypoSchema
    .optional()
    .describe(
      "Scena TIPOGRAFICA parametrica (add-on Tipografia Cinetica): testo animato ad alto contrasto a COSTO ZERO API. Modi: lines/flip/repeat/counter. Quando presente, visualPrompt/text vengono ignorati e la scena salta la generazione video. Si mescola con scene video-AI nello stesso reel."
    ),
  imageUrl: z
    .string()
    .optional()
    .describe(
      "Path relativo (al reelDir) di un'immagine statica 9:16 da renderizzare con Ken Burns subtle (es. dashboard pre-renderizzata, mockup CRM). Quando presente, la scena salta Stage 2 (no Kling) e viene composta da BasicReel come BackgroundImage. Mutually exclusive con visualPrompt non vuoto, kinetic, kineticDashboard."
    ),
  kenBurnsRange: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      "Range zoom Ken Burns [start, end] per scene imageUrl. Per due scene consecutive con la stessa imageUrl, incatena i range (es. [1.0,1.085] poi [1.085,1.17]) per uno zoom CONTINUO invece di due zoom-in ripetuti. Default BackgroundImage: [1, 1.15]."
    ),
  hideSubtitle: z
    .boolean()
    .optional()
    .describe(
      "Se true, sopprime il sottotitolo globale durante questa scena (stesso gating per-frame delle card). Usare per gli spezzoni splice che hanno già i sottotitoli impressi nel footage originale, per evitare la doppia caption."
    ),
  nameplate: z
    .string()
    .optional()
    .describe(
      "Targa lower-third da talk show sovrimpressa (es. 'LA SUA EX SDR'). Render Remotion (componente Nameplate), bottom ~16%, non collide coi sottotitoli (top 62%). Default: visibile per tutta la scena; finestra parziale via nameplateWindow."
    ),
  nameplateWindow: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe(
      "Finestra [fromSec, toSec] di visibilita' della nameplate dentro la scena. Per riprese multi-personaggio con camera move: la targa segue solo il tratto in cui il personaggio etichettato e' in frame (es. [0, 4] = solo prima meta')."
    ),
  durationSec: z.number().positive().describe("Durata stimata in secondi (fallback se voiceoverSegment manca)"),
  voiceoverSegment: z
    .string()
    .optional()
    .describe(
      "Frammento esatto del voiceoverText che corrisponde a questa scena. Usato per calcolare la durata reale della scena dai word timestamps di ElevenLabs."
    ),
  continuity: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Se true, questa scena viene generata con image-to-video usando l'ultimo frame della scena precedente come first-frame. La prima scena non può avere continuity: true."
    ),
  firstFrameImagePath: z
    .string()
    .optional()
    .describe(
      "Path locale a un'immagine da usare come first-frame per image-to-video. Ha priorità su continuity. Utile per ancorare una scena a un'immagine specifica (es. foto reale)."
    ),
  lastFrameImagePath: z
    .string()
    .optional()
    .describe(
      "Path (relativo a reelDir o assoluto) a un'immagine da usare come ULTIMO frame (tail / last-frame conditioning) nell'image-to-video Kling: il clip interpola DAL keyframe/firstFrame iniziale A questa immagine finale. Usato per i MORPH dove serve una trasformazione che Kling non sa fare da solo (es. invecchiamento bocca 18→80: keyframe=labbra giovani, lastFrameImagePath=labbra vecchie). Funziona solo sul path kling-legacy i2v."
    ),
  sourceClip: z
    .object({
      file: z
        .string()
        .describe(
          "Path al video sorgente (relativo a reelDir o assoluto): l'ad originale o un segmento già estratto."
        ),
      startSec: z
        .number()
        .nonnegative()
        .optional()
        .describe("Inizio del segmento da estrarre (sec). Se omesso: dall'inizio del file."),
      endSec: z
        .number()
        .positive()
        .optional()
        .describe("Fine del segmento (sec). Se omesso: fino alla fine del file."),
      cropTopFrac: z
        .number()
        .min(0)
        .max(0.8)
        .optional()
        .describe("Frazione (0-1) da TAGLIARE dall'alto prima di riscalare a 1080x1920. Usato per rimuovere i sottotitoli/label impressi nell'originale (tipicamente nel terzo alto). Es. 0.35 toglie il 35% superiore."),
      cropBottomFrac: z
        .number()
        .min(0)
        .max(0.8)
        .optional()
        .describe("Frazione (0-1) da tagliare dal basso prima di riscalare. Per sottotitoli impressi in basso."),
    })
    .optional()
    .describe(
      "SPLICE / RECUPERO DALL'ORIGINALE — usa un segmento VERBATIM di un video sorgente come clip di questa scena (es. talking-head, before/after o prodotto-con-scritte dell'ad originale che l'AI non riproduce fedele). Lo Stage 2 NON genera nulla: ffmpeg-estrae [startSec,endSec] da `file` in assets/scene-N.mp4 (re-encode a 1080x1920/30fps, audio rimosso — audioMode=elevenlabs sovrappone il VO). `hideSubtitle` defaulta a true (caption già impresse nel footage originale). Mutuamente esclusiva con visualPrompt non vuoto, keyframe, firstFrameImagePath, imageUrl, dashboardComponent, kinetic, kineticDashboard. Integra con --skip-existing-videos. Usato dal processo 'refresh creativo' per le scene marcate splice."
    ),
  provider: z
    .enum(["kling", "veo3", "heygen"])
    .optional()
    .describe(
      "Provider video per QUESTA scena. Default: 'kling' (Kling 3.0 Pro). 'veo3' per dialogo nativo + lipsync (talking animals/characters). 'heygen' per avatar talking-head fotorealistico (Avatar 4 quality, futuro Avatar 5) con audio pre-generato da ElevenLabs."
    ),
  avatarId: z
    .string()
    .optional()
    .describe(
      "Avatar HeyGen per QUESTA scena. Solo per provider='heygen'. Se omesso, viene letto da HEYGEN_DEFAULT_AVATAR_ID nell'env. L'engine (Avatar 4 quality/turbo o Avatar 5 quando uscirà) viene scelto automaticamente da HeyGen in base alle capabilities dell'avatar."
    ),
  dialogue: z
    .string()
    .optional()
    .describe(
      "Dialogo nativo iniettato nel prompt Veo con sintassi '<speaker> says (in <lingua>): \"...\"'. Solo per provider='veo3'. buildVeoPrompt() lo combina con visualPrompt + speaker + sfx + ambient in paragrafi separati. Una battuta per scena: il multi-speaker in un singolo clip è il punto debole di tutti i modelli video → una voce per scena, cuci in post."
    ),
  speaker: z
    .string()
    .optional()
    .describe(
      "Chi pronuncia `dialogue`, nominato esplicitamente per evitare misassignment della voce nelle scene multi-personaggio (es. 'the EMAIL MARKETING guest, a brash blonde woman in leopard print'). Solo per provider='veo3'. Default: 'The character on screen'. Per reel animali impostare es. 'The cat'."
    ),
  dialogueLang: z
    .string()
    .optional()
    .describe(
      "Lingua del dialogo Veo, usata nella sintassi 'says (in <lang>)'. Default: 'Italian'. Impostare 'English' per format in inglese (es. talk-show stile US come l'ad GoHighLevel)."
    ),
  sfx: z
    .string()
    .optional()
    .describe(
      "Effetti sonori generati NATIVAMENTE dentro il clip Veo, in un paragrafo 'SFX:' separato (es. 'studio audience gasps, then a single shout', 'applause and cheering'). Solo per provider='veo3'. Descrivere esplicitamente — Veo non li inferisce."
    ),
  ambient: z
    .string()
    .optional()
    .describe(
      "Ambience / room-tone generato dentro il clip Veo, in un paragrafo 'Ambient:' separato (es. 'live TV studio room tone, distant crowd murmur'). Solo per provider='veo3'."
    ),
  veoDuration: z
    .union([z.literal(4), z.literal(6), z.literal(8)])
    .optional()
    .describe("Durata clip Veo 3 in secondi (4, 6, o 8). Solo per provider='veo3'. Default: 8."),

  // ---------------------------------------------------------------------------
  // STORYBOARD + IMAGE-TO-VIDEO (workflow text → image → video, da 2026-05-27)
  // Pilot un cliente B2B validato 2026-05-27: Gemini 3 Pro Image 9.5/10 vs Imagen 4
  // Ultra / Nano Banana Pro / Seedream / Flux 2 / Gemini Flash. Seedance 2.0 fast
  // via Higgsfield batte Kling 3.0 std 4-2 su image-to-video. Vedi memorie:
  // [[project-pilot-image-gen-6way-2026-05-27]] + [[feedback-default-image-model-gemini3-pro]].
  // Tutti i campi sotto sono OPZIONALI → zero breaking change sui reel storici.
  // ---------------------------------------------------------------------------
  keyframe: z
    .string()
    .optional()
    .describe(
      "Path locale al keyframe PNG generato per questa scena (relativo a reelDir, es. 'assets/keyframes/scene-3.png'). Quando presente, lo Stage 2 usa image-to-video con questo come start_image. Generato da Stage 1.7 Storyboard (gemini-3-pro-image-preview) o fornito manualmente."
    ),
  keyframePromptHash: z
    .string()
    .optional()
    .describe(
      "Hash SHA-1 di (visualPrompt + keyframeReferenceUrl) usato per generare il keyframe. La pipeline invalida la cache se cambia. Non scrivere a mano — è gestito da Stage 1.7."
    ),
  keyframeReferenceUrl: z
    .string()
    .optional()
    .describe(
      "URL Pinterest pin (es. 'https://it.pinterest.com/pin/12345/') o URL https:// diretto da usare come reference composizione per il keyframe Gemini. Per Pinterest la pipeline estrae automaticamente l'immagine dalla CDN i.pinimg.com (vedi [[reference-pinterest-image-access]])."
    ),
  keyframeApproved: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "GATE 4 — Approvazione human-in-the-loop del keyframe. La pipeline blocca lo Stage 2 image-to-video se ci sono keyframe non approvati. Si attiva via marker file `assets/keyframes/scene-N.png.approved` (touch) o via HTML gallery. Bypass: --bypass-keyframe-gate (sconsigliato)."
    ),
  omnihumanPrompt: z
    .string()
    .optional()
    .describe(
      "Prompt testuale passato a OmniHuman v1.5 (--omnihuman) per QUESTA scena. OmniHuman v1.5 segue istruzioni testuali, a differenza della v1.0. USO PRINCIPALE: sopprimere le braccia/mani allucinate sui personaggi NON-UMANI parlanti (pergamena, animali, oggetti) — OmniHuman, animando un 'corpo' anomalo, tende a far crescere arti spuri/duplicati. Se omesso, la pipeline applica di default OMNIHUMAN_NO_LIMBS_PROMPT (anti-arti). Per un soggetto UMANO con OmniHuman, impostarlo a stringa vuota \"\" per disabilitare l'anti-arti, o a un prompt su misura. Validato 2026-06-15 sul reel N2 (pergamena clay): il default anti-arti elimina le braccia allucinate (voto 4/10 → 10/10)."
    ),
  videoEngine: z
    .enum(["kling-legacy", "veo3", "heygen", "seedance", "kling-hf"])
    .optional()
    .describe(
      "Motore video per QUESTA scena. DEFAULT 2026-05-28: kling-legacy=fal.ai Kling 3.0 Pro (raccomandato — qualità superiore, costo ~$0.50/5s, supporta image-to-video con keyframe). veo3/heygen come prima. DEPRECATED: seedance/kling-hf via Higgsfield MCP — disabilitato 2026-05-28 (costo irragionevole vs fal.ai, qualità inferiore validata sul reel un-reel-cliente). Mantenuti per backward compat con reel storici ma NON usare per nuovi reel."
    ),
  videoEngineMode: z
    .enum(["fast", "std", "pro", "4k"])
    .optional()
    .describe(
      "Tier qualità/costo del motore video. Ignorato per kling-legacy/veo3/heygen. Storico Higgsfield (deprecated): seedance 'fast'/'std', kling-hf 'std'/'pro'/'4k'."
    ),
  videoMotionPrompt: z
    .string()
    .optional()
    .describe(
      "Prompt descrittivo del MOVIMENTO video (camera move, micro-life, animazione soggetti) separato dal visualPrompt che descrive la SCENA STATICA del keyframe. Usato come prompt per Seedance/Kling image-to-video. Se assente, viene usato visualPrompt anche per il video. Esempio: 'Slow dolly-in toward subject, subject blinks naturally, papers rustle slightly from breeze.'"
    ),
});

/**
 * Singolo segmento audio in modalità multi-voce.
 *
 * Quando lo script include `voiceoverSegments`, la pipeline genera un file audio
 * separato per ogni segmento (con il suo voiceId), poi li concatena in un unico
 * voiceover.mp3. Le word-timestamps vengono offsetate cumulativamente, così
 * il sync VO↔scene continua a funzionare contro il voiceover concatenato.
 *
 * Use case: dialoghi a 2+ personaggi (es. talking cats), interviste, ping-pong
 * fra speaker diversi nello stesso reel.
 */
export const VoiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  useSpeakerBoost: z.boolean().optional(),
  speed: z.number().min(0.7).max(1.5).optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const VoiceoverSegmentSchema = z.object({
  voiceId: z.string().describe("Voice ID di ElevenLabs per QUESTO segmento"),
  text: z
    .string()
    .describe(
      "Testo da pronunciare per QUESTO segmento. In eleven_v3 può contenere Audio Tags fra parentesi quadre — es. '[whispers]', '[excited]', '[bored sigh]', '[shouts]', '[curious]', '[serious tone]'. ALL CAPS = enfasi gridata. Ellissi … e em-dash — controllano il ritmo."
    ),
  speaker: z
    .string()
    .optional()
    .describe("Etichetta opzionale del personaggio (es. 'Gatto A', 'Intervistatore') — solo per leggibilità/debug"),
  modelId: z
    .string()
    .optional()
    .describe("Override del modelId per QUESTO segmento (default: usa script.voiceModelId o eleven_v3)"),
  voiceSettings: VoiceSettingsSchema.optional().describe(
    "Override fine delle voice settings per QUESTO segmento. Utile per battute estreme (urlate, sussurrate, sotto-voce). Valori non specificati ereditano i default della funzione."
  ),
  silenceAfterMs: z
    .number()
    .min(0)
    .max(3000)
    .optional()
    .describe(
      "Millisecondi di silenzio da inserire DOPO questo segmento prima del prossimo. Default: il valore globale di generateVoiceoverMulti (~350ms). Usa 0 per attaccare due battute, valori più alti per pause drammatiche."
    ),
});

export type VoiceoverSegment = z.infer<typeof VoiceoverSegmentSchema>;

export const ReelScriptSchema = z
  .object({
    hook: z.string().describe("Frase di apertura — deve catturare attenzione in 1-2 sec"),
    scenes: z.array(ReelSceneSchema).min(2).max(40),
    cta: z.string().describe("Call to action finale"),
    voiceoverText: z
      .string()
      .optional()
      .describe(
        "Testo completo per il voiceover TTS (single-voice mode). Mutuamente esclusivo con voiceoverSegments — fornire uno dei due."
      ),
    voiceoverSegments: z
      .array(VoiceoverSegmentSchema)
      .min(2)
      .optional()
      .describe(
        "Sequenza di segmenti audio multi-voce. Quando presente, la pipeline genera ogni segmento con il suo voiceId e li concatena. Mutuamente esclusivo con voiceoverText."
      ),
    voiceId: z
      .string()
      .optional()
      .describe("Override del voice ID di ElevenLabs in single-voice mode (altrimenti usa ELEVENLABS_VOICE_ID da .env). Ignorato se sono presenti voiceoverSegments."),
    voiceModelId: z
      .string()
      .optional()
      .describe("Override del model ID di ElevenLabs (default: eleven_v3). Gli Audio Tags v3 vengono saltati automaticamente per modelli diversi da eleven_v3. In multi-voce funziona come default per i segmenti che non specificano modelId."),
    voiceSettings: VoiceSettingsSchema.optional().describe(
      "Override delle voice settings (stability/similarityBoost/style/speed/useSpeakerBoost) in single-voice mode. Ignorato se sono presenti voiceoverSegments (in multi-voce ogni segmento ha le sue)."
    ),
    totalDurationSec: z.number().positive().describe("Durata totale stimata in secondi"),
    style: z
      .enum(["basic", "talking-head", "product", "text-overlay"])
      .describe("Template di composizione da usare"),
    subtitleStyle: z
      .object({
        fontFamily: z.string().optional(),
        fontWeight: z.union([z.number(), z.string()]).optional(),
        color: z.string().optional(),
        highlightColor: z.string().optional(),
        strokePx: z.number().optional(),
        strokeColor: z.string().optional(),
        kinetic: z
          .boolean()
          .optional()
          .describe(
            "Se true, i sottotitoli usano una variante KINETIC (vedi `variant`) invece del karaoke piatto. Raccomandato per i talking-head."
          ),
        variant: z
          .enum(["rise", "motion"])
          .optional()
          .describe(
            "Variante kinetic (solo se kinetic=true). 'rise' (default): KineticSubtitle, rise word-by-word + parola attiva oro, copertura totale, safe-zone (supporta syncTo beat). 'motion': KineticCaptionsArt, motion typography di produzione — UN solo font (captionFont, default Anton), parola-hero ingrandita+oro+glow, parole future fantasma, banda bassa centrata, larghezza robusta via measureText (mai off-screen). Per talking-head/frontali dinamici."
          ),
        syncTo: z
          .enum(["voice", "beat"])
          .optional()
          .describe(
            "Sorgente di sync dei sottotitoli kinetic. 'voice' (default): agganciati ai word-timestamps della voce (contenuto voice-driven). 'beat': le parole si agganciano alla griglia `musicBeats` del reel (contenuto music-driven, voce già recitata sul beat). Per 'beat' serve `musicBeats` nel reel (da `pnpm beat-detect`). Supportato solo da variant 'rise'."
          ),
        captionFont: z
          .enum(["anton", "oswald", "bebas", "archivo", "inter"])
          .optional()
          .describe(
            "[variant motion] Font UNICO dei sottotitoli, adatto alla direzione artistica del video. Default 'anton' (Impact-style condensed, ottimo per frontali semplici). Deve essere caricato in remotion/utils/fonts.ts."
          ),
        baseSize: z.number().optional().describe("[variant motion] Dimensione base px @1080w. Default 92."),
        heroScale: z.number().optional().describe("[variant motion] Moltiplicatore della parola-hero. Default 1.34."),
        bottomPct: z.number().optional().describe("[variant motion] Distanza dal fondo (0-1). Default 0.15 (banda bassa)."),
        maxWordsPerGroup: z.number().optional().describe("[variant motion] Parole max per blocco. Default 4."),
      })
      .optional()
      .describe(
        "Override stile sottotitoli (default Inter bold bianco). Es. un brand cliente = serif GT Super bianco + outline nero. Passa attraverso composition-props → BasicReel → Subtitle."
      ),
    musicBeats: z
      .array(z.number())
      .optional()
      .describe(
        "Griglia di beat (in frame @ fps composition) della musica di sottofondo, generata da `pnpm beat-detect <traccia>`. Usata SOLO quando subtitleStyle.syncTo === 'beat' (contenuto music-driven): i sottotitoli kinetic agganciano i reveal a questi beat. La voce resta l'audio (la musica è sottofondo via musicUrl, mixata sotto)."
      ),
    audioMode: z
      .enum(["elevenlabs", "veo-native"])
      .optional()
      .describe(
        "FORMAT AUDIO del reel — due format mutuamente esclusivi, NIENTE ibrido (deciso 2026-06-01). " +
          "'elevenlabs': voiceover ElevenLabs esterno + video Kling/HeyGen (path classico, es. un cliente B2B). " +
          "'veo-native': attori Veo 3.1 con audio italiano nativo embedded nei clip, nessun voiceover esterno. " +
          "Se omesso, la pipeline lo DERIVA dai provider delle scene (tutte veo3 → veo-native, altrimenti elevenlabs) e lo valida. " +
          "Dichiararlo esplicitamente è raccomandato: rende il routing a prova di errore (lo Stage 1 ElevenLabs è gateato su questo valore)."
      ),
  })
  .superRefine((data, ctx) => {
    // Classifica le scene che PRODUCONO un video clip (escludi TEXT/KINETIC/
    // KINETIC-DASHBOARD/dashboardComponent/immagine statica — non hanno provider video).
    // Mutual-exclusion: una scena SPLICE (sourceClip) non può anche avere un
    // altro path di rendering — produrrebbe ambiguità su cosa montare.
    data.scenes.forEach((s, i) => {
      if (
        s.sourceClip &&
        (s.visualPrompt.trim() !== "" ||
          s.keyframe ||
          s.firstFrameImagePath ||
          s.imageUrl ||
          s.dashboardComponent ||
          s.kinetic ||
          s.kineticDashboard)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Scena con sourceClip (splice) non può avere anche visualPrompt/keyframe/firstFrameImagePath/imageUrl/dashboardComponent/kinetic/kineticDashboard: sono path di rendering alternativi. Lasciali vuoti sulle scene splice.",
          path: ["scenes", i, "sourceClip"],
        });
      }
    });

    const videoScenes = data.scenes.filter(
      (s) =>
        (s.visualPrompt.trim() !== "" || s.provider === "heygen") &&
        !s.kinetic &&
        !s.kineticDashboard &&
        !s.dashboardComponent &&
        !s.imageUrl &&
        !s.sourceClip
    );
    const providers = new Set(videoScenes.map((s) => s.provider ?? "kling"));
    const hasVeo = providers.has("veo3");
    const hasNonVeo = providers.has("kling") || providers.has("heygen");

    // GUARDIA 1 — niente ibrido: o TUTTE le scene video sono veo3 (audio nativo),
    // o NESSUNA. Mischiare veo3 con kling/heygen produrrebbe doppio audio (clip
    // Veo con voce embedded + voiceover ElevenLabs sopra l'intero reel).
    if (hasVeo && hasNonVeo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Reel ibrido non supportato: le scene video mischiano provider 'veo3' con 'kling'/'heygen' → doppio audio. Usa un solo format: o TUTTE le scene video veo3 (audio nativo), o NESSUNA (Kling/HeyGen + voiceover ElevenLabs).",
        path: ["scenes"],
      });
      return;
    }

    // Modalità effettiva: dichiarata se presente, altrimenti derivata dai provider.
    const derived: "elevenlabs" | "veo-native" =
      hasVeo && !hasNonVeo ? "veo-native" : "elevenlabs";
    const mode = data.audioMode ?? derived;

    // GUARDIA 2 — audioMode dichiarato deve combaciare coi provider effettivi.
    if (data.audioMode && data.audioMode !== derived) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `audioMode='${data.audioMode}' incoerente con i provider delle scene (derivato: '${derived}'). ` +
          (data.audioMode === "veo-native"
            ? "Per 'veo-native' TUTTE le scene video devono avere provider:'veo3'."
            : "Per 'elevenlabs' NESSUNA scena video può avere provider:'veo3'."),
        path: ["audioMode"],
      });
      return;
    }

    // GUARDIA 3 — requisiti voiceover per modalità.
    const hasVoiceover =
      (data.voiceoverText !== undefined && data.voiceoverText.trim().length > 0) ||
      (data.voiceoverSegments !== undefined && data.voiceoverSegments.length > 0);

    if (mode === "elevenlabs" && !hasVoiceover) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Modalità 'elevenlabs': serve `voiceoverText` (single-voice) o `voiceoverSegments` (multi-voce).",
        path: ["voiceoverText"],
      });
    }
    if (mode === "veo-native" && hasVoiceover) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Modalità 'veo-native': l'audio viene dai clip Veo (nativo, via campo `dialogue` per scena). Rimuovi `voiceoverText`/`voiceoverSegments` per evitare doppio audio.",
        path: ["voiceoverText"],
      });
    }
  });

export type ReelScene = z.infer<typeof ReelSceneSchema>;
export type ReelScript = z.infer<typeof ReelScriptSchema>;
