# Reel Engine — Project Instructions

Pipeline per la produzione di reel: Claude scrive un **Director's Treatment** approvato dall'utente, poi genera il voiceover (approvato dall'utente), poi genera i visual Kling (irreversibile) e infine compone il MP4. Quattro **gate human-in-the-loop** prima dello step irreversibile.

## Workflow Completo

```
FASE 0 — INPUT
  Copy / concept / brief dell'utente

FASE 1 — DIRECTOR'S TREATMENT (Claude, in conversazione)
  Documento strutturato salvato come treatment.md nella cartella del reel.
  Sezioni: tesi, north-star references, palette+lighting+camera language,
  hook frame-by-frame, beat narrativi, KINETIC-DASHBOARD declaration,
  Vision vs Reality.
  🟡 GATE 1 — USER APPROVA treatment.md prima di proseguire.

FASE 2 — SCENE-VO MAPPING (Claude, in conversazione)
  Tabella semplice "frase del voiceover → scena visiva (1 riga)".
  Numero di scene KINETIC-DASHBOARD emerge dal copy (0/1/2/3+), non a priori.
  🟡 GATE 2 — USER APPROVA il mapping (può chiedere split/merge/riformulazione).

FASE 3 — SCRIPT.JSON (Claude, in conversazione)
  Traduce treatment + mapping in script.json validato da Zod.
  Ogni visualPrompt incorpora le direttive dal treatment.

FASE 4 — VOICE ONLY (CLI)
  pnpm reel "path/to/script.json" --audio-only
    └→ ElevenLabs voiceover + word timestamps (~$0.30, ~30s)
  🟡 GATE 3 — USER ASCOLTA voiceover.mp3 + decide se regenerare con
     voice settings diversi (iterazione cheap) o se andare avanti.

FASE 4.5 — STORYBOARD (CLI, ~$0.50-0.80)
  pnpm storyboard "path/to/script.json" --from "<reel-dir>"
    ├→ Per ogni scena con visualPrompt (non KINETIC/HeyGen/Veo3):
    │     Gemini 3 Pro Image → keyframes/scene-N.png (~$0.06-0.10)
    │     + reference Pinterest auto-estratto se keyframeReferenceUrl presente
    ├→ Cache via hash(visualPrompt + ref): skip se invariato
    └→ Genera keyframes.html gallery responsive 9:16
  🟡 GATE 4 — USER APRE keyframes.html, approva ogni keyframe con
     touch scene-N.png.approved (oppure regenera con --force-regen=N).
     Rationale: errori del keyframe si propagano nel video Kling i2v
     (validato pilot 2026-05-27 scene 8 → "Call Me Back" inglese inherited).

FASE 5 — VIDEO + RENDER (CLI, irreversibile, ~$5-7 fal.ai per reel 2 min)
  pnpm reel "path/to/script.json" --video-only --from "<reel-dir>"
    ├→ Auto-sync durationSec dal voiceover reale (Stage 1.5)
    ├→ GATE 4 enforcement: blocca se ci sono keyframe non approvati
    │     (bypass: --bypass-keyframe-gate, sconsigliato)
    ├→ Stage 2 branch su videoEngine per ogni scena:
    │     • kling-legacy   → fal.ai Kling 3.0 Pro (DEFAULT 2026-05-28, ~$0.50/5s, image-to-video)
    │     • veo3 / heygen  → invariati
    │     • seedance/kling-hf → DEPRECATED (Higgsfield MCP disabilitato 2026-05-28)
    ├→ Remotion (compositing → MP4)
    └→ scene-map.md (L1 review automatica, gratis)
        └→ [se --vision]: L2 Gemini Pro vision audit (~$0.30-0.80)

FASE 6 — REVIEW (Claude + Michel)
  Apri scene-map.md: gate sync, FREEZE detection, file mancanti.
  Opzionale: pnpm scene-map <reel-dir> --vision per audit Gemini.
```

## Human-in-the-loop gates 🟡

Quattro punti di approvazione esplicita prima dello step irreversibile (video + render). **Mai saltare un gate senza approvazione utente esplicita**. Quando arrivo a un gate uso `AskUserQuestion` per la decisione binaria approva/itera + raccolgo il feedback specifico se chiede iterazione.

| Gate | Quando | Artefatto da approvare | Comando di iterazione |
|------|--------|------------------------|----------------------|
| **GATE 1 — Treatment** | Dopo FASE 1, prima dello storyboard | `treatment.md` nella cartella del reel | Editing inline del treatment finché l'utente non approva |
| **GATE 2 — Mapping** | Dopo FASE 2, prima del script.json | Tabella scene↔frasi (in chat) | Split/merge/riformulazione delle righe finché approvato |
| **GATE 3 — Voice** | Dopo FASE 4 (voiceover generato), prima dello storyboard | `voiceover.mp3` (la CLI stampa il comando `open` pronto da copiare) | `pnpm reel <script> --audio-only --from <reel-dir>` con voice settings diversi |
| **GATE 4 — Keyframes** | Dopo FASE 4.5 (storyboard generato), prima del video Kling (Stage 2) | `keyframes.html` gallery + marker `.approved` per scena | `pnpm storyboard <script> --from <reel-dir> --force-regen=N` per rigenerare scene specifiche |

**Regola d'oro economica**: prima del GATE 4 ogni errore costa ~$0.10 e 20s (rigeneri il keyframe Gemini). Dopo GATE 4 ogni errore costa ~$0.50-2 per scena (fal.ai Kling) e ~5 min di processing. I gate esistono per spostare la maggior parte degli errori a sinistra di GATE 4.

## Architettura

```
scripts/generate-reel.ts    ← Entry point CLI: pnpm reel "path/to/script.json"
  └→ src/pipeline.ts        ← Orchestrator 3 stadi (voiceover → visuals → composition)
      ├→ src/services/elevenlabs.ts  ← TTS voiceover + word timestamps
      ├→ src/services/fal.ts         ← Image/video/lip-sync generation
      └→ Remotion render             ← Compositing finale → MP4

remotion/                    ← Compositions e componenti React
  ├→ Root.tsx               ← Registra tutte le composizioni
  ├→ compositions/          ← Template reel (BasicReel, TalkingHead, etc.)
  └→ components/            ← Componenti riusabili (AnimatedText, Subtitle, etc.)
```

---

## FASE 1 — Director's Treatment

**Quando**: SEMPRE prima di generare lo storyboard. Mai saltare. È il primo gate human-in-the-loop.

**Input**: copy approvato, concept, brief, o qualsiasi testo che descriva il contenuto del reel.

**Filosofia**: il treatment è il documento che usi per "vendere" la visione visiva del reel a chi la deve approvare (qui: l'utente). Non è un elenco di campi — è un documento narrativo che mostra COSA verrà visto, COME, e PERCHÉ funziona. Metodologia ispirata a Nur Niaz (Samsung, Coca-Cola, Red Bull, Toyota) e ai director's treatment commerciali. **Reference-driven**: ogni scelta visiva è ancorata a un'opera specifica che l'utente può cercare e vedere.

**Processo**:
1. Leggere `memory/context.md` del cliente per lo stile visivo approvato e i vincoli del brand (palette, confidenzialità, voce/tone)
2. Analizzare il copy per cue narrative: tensione → risoluzione, beat emotivi, "momenti dato" che invocano dashboard, momenti contemplativi vs energetici
3. **Costruire una shortlist di reference** (5-8 opere) usando le librerie di reference dei director: [Frame Set](https://frameset.app) (film stills), [Cosmos](https://www.cosmos.so/) (collezione visiva ricercabile), [Art of the Title](https://www.artofthetitle.com/) (title sequences per typography kinetic), Cover Junkie (editorial magazine covers). Citare per NOME — l'utente può googlare. Niente reference vaghe ("anni '80 cinematografico").
4. Scrivere il treatment in markdown e SALVARLO come `<reel-dir>/treatment.md`. L'utente lo apre con un click → cliente lo legge → approva o itera. È l'artefatto del GATE 1.

**Output**: file `treatment.md` con questa struttura ESATTA:

````markdown
# Director's Treatment — <Titolo del reel>

> Cliente: <slug> · Durata target: ~Xs · Formato: 9:16 vertical · Data: YYYY-MM-DD

## 1. Tesi
<Una frase che cattura la promessa del reel — non il messaggio del copy, ma cosa il reel
fa sentire al viewer. Es. "Il reel mostra il passaggio dal caos isolato di 4 strumenti
scollegati alla calma operativa di un singolo cervello unificato."

## 2. Visual North Star — Reference
Lista numerata di 5-8 opere specifiche con motivazione. Ogni reference indica COSA
prendiamo da quell'opera (non "prendiamo tutto").

1. **<Opera, anno, autore>** — <cosa prendiamo>. Es.
   "*Drive* (2011, Refn) — palette desaturata + ritmo a respiro lento + luce al neon usata come temperatura emotiva, non come spettacolo."
2. **Sebastião Salgado, serie Workers (1993)** — silhouette in controluce, sguardo dignitoso sul lavoro umano.
3. **Mr. Robot opening titles (Patrick Clair, Antibody)** — kinetic typography frantumata, tipografia come stato emotivo.
4. **Apple "Privacy. That's iPhone" (2019, TBWA)** — close-up estremi su gesti minimi, narrazione per gesto.
[...]

## 3. Palette
HEX + fonte (da quale reference viene questo colore).

- `#1B2434` Deep Navy — dalla scena finale di *Drive*
- `#0E1116` Carbon Black — ombre Salgado
- `#E8E1D2` Bone White — toni epidermici nei controluce
- `#C9A36B` Warm Brass — accent caldo per la fase "soluzione"

## 4. Lighting design
Setup specifico per fase narrativa. Niente "warm lighting" — descrizione tecnica.

- **Fase problema (prima metà)**: monitor blue 4800K key from off-camera at 45°, no fill, ombre profonde, mood Sebastião Salgado dignitoso ma tragico
- **Fase soluzione (seconda metà)**: warm overhead 3200K + soft warm side fill from windows, no high contrast, mood respirato, mood Apple/Steve McCurry

## 5. Camera language
Camera, lente, movimento per ciascuna fase.

- Camera body reference: Arri Alexa Mini look (medium contrast, healthy skin)
- Lens: 35mm e 50mm prevalenti, shallow DOF f/1.8 default
- Movimenti: dolly-in lento sui beat emotivi, statico sui pattern interrupt, mai handheld nervoso

## 6. Texture / post
- 35mm Kodak Gold 200 grain (subtle, non grunge)
- Micro-vignette agli angoli
- Selective desaturation dei blu nella fase problema, warm saturation boost nella fase soluzione

## 7. Hook visivo (primi 3 secondi) — frame-by-frame
Descrizione granulare, frame-per-frame, dei primi 3 secondi del reel. Non astratto.

**Frame 0:** [cosa si vede esattamente nel primo frame — soggetto, posa, luce, framing]
**Frame 0-1s:** [movimento camera + cosa accade]
**Frame 1-3s:** [evoluzione + dove si chiude per dare spazio al primo cut]

**Reference dell'hook**: <opera specifica, secondi precisi se possibile>. Es. "Mr. Robot S1E1 prima inquadratura (0:00-0:04) — silhouette davanti a monitor, l'audio è il drive del visual."

**Perché funziona**: <una frase — che pattern interrupt produce sullo scroll>.

## 8. Beat narrativi chiave
Per ogni beat del copy (tipicamente 3-6), 1 paragrafo + 1 reference. Non è ancora la lista delle scene — è il livello sopra (es. "transizione cold→brass" è un beat, può essere 1 o 2 scene).

- **Beat 1 — Caos isolato**: <descrizione visiva + reference>
- **Beat 2 — Customer frustrato**: <...>
- **Beat 3 — Transizione brass**: <...>
[...]

## 9. KINETIC-DASHBOARD declaration
**Il numero di dashboard EMERGE DAL COPY, non è a priori.** Analizza dove il copy chiede esplicitamente "dato/numero/report/dashboard". Se il copy è puramente storytelling → 0 dashboard. Se ha 1 momento dato → 1. Se ha 3 momenti dato distinti → 3.

Per ciascuna dashboard dichiarata:
- **Posizione nel copy**: <quale frase del voiceover la innesca>
- **Tipo di pannello**: trend / donut / bars (o combinazione)
- **Dati**: <i numeri esatti che vanno nei pannelli>
- **Fonte dei numeri**: `[REAL]` (dal backend del cliente — chiedere a Michel) | `[ILLUSTRATIVE]` (numeri plausibili dichiarati come esempio nel video) | `[FROM COPY]` (citati esplicitamente nel copy)
- **Scopo narrativo**: <perché questo numero qui — cosa convince il viewer>

> **Mai inventare numeri**. Se non hai una fonte chiara → chiedi a Michel oppure proponi `[ILLUSTRATIVE]` con disclaimer nel video.

## 10. Vision vs Reality
Tabella esplicita dell'achievability per ogni tipo di shot in questo reel. Calibra le aspettative dell'utente sulla fattibilità con fal.ai/Kling/Remotion.

| Beat / scena tipo | Ideale cinematografico | Fattibile con la pipeline | Trade-off accettato |
|-------------------|------------------------|---------------------------|---------------------|
| Hook 4-panel comic | Stesso attore in 4 panel coerenti | Kling text-to-video 4-panel layout: ogni attore diverso, OK | Identità non importante, è simbolico |
| KINETIC-DASHBOARD | Aftermath/Decoupled-grade motion graphics | Remotion KineticDashboard component, numeri count-up | Estetica meno premium ma 100% leggibile |
| Volti close-up | Veo 3 quality (rare facial artifacts) | Kling 3.0 Pro (artefatti facciali occasionali) | Accettato se shot ≤3s e DOF molto shallow |
| Transizione cold→brass | Camera che cambia temperatura LIVE in clip | Spezzato in 2 scene: fine cold + inizio brass | Hard cut sintetico ma leggibile |
| [...] | | | |

## 11. DO NOT
- <cosa NON deve esserci in questo reel — branding vietato, cliché da evitare, anti-pattern specifici>
- Es.: vincoli di confidenzialità del cliente (brand precedenti da non nominare, claim vietati - chiedi a Michel il file confidentiality del progetto)
- Es. generale: "Mai stock corporate sorridente, mai handheld nervoso, mai schermi frontali con UI improvvisata dal modello (se la scena richiede schermo/testo leggibile → recipe TEXT-IN-SCENE)"

---

*Treatment approvato:* ⬜  *Iterazioni:* <numero>  *Approvazione: <data>*
````

**Regole del treatment:**

- I colori SEMPRE in HEX con FONTE (da quale reference viene)
- Le reference sono SEMPRE specifiche: opera + anno + autore (+ secondi se applicabile)
- L'hook è SEMPRE frame-by-frame, mai astratto
- KINETIC-DASHBOARD count emerge dal copy — proponilo, motivalo, dichiara la fonte dati. Se non hai i dati reali → chiedi all'utente PRIMA di chiudere il treatment
- Vision vs Reality è obbligatoria: l'utente deve vedere cosa è ideale e cosa è il compromesso accettato
- DO NOT è obbligatoria e attinge dal `memory/confidentiality.md` del cliente quando esiste
- Il treatment è breve ma denso — punta a 1-2 schermate, non un romanzo

**Reference libraries** (citare ma non linkare nel treatment, sono per Claude):
- [Frame Set](https://frameset.app) — film stills database ricercabile per mood/colore
- [Cosmos](https://www.cosmos.so/) — collezione visiva ricercabile + AI-detection
- [Art of the Title](https://www.artofthetitle.com/) — title sequences come reference per typography
- [Pitch Studio](https://pitch-studio.com/) — template di director's treatment (Nur Niaz)

---

## FASE 2 — Storyboard

**Quando**: DOPO l'art direction. Mai generare uno storyboard senza aver definito prima la direzione visiva.

**Input**: testo/copy del reel + blocco ART DIRECTION completato. Opzionalmente: durata target, formato (reel breve 15-30s / reel lungo 60-90s).

**Dipendenza narrativa**: la struttura narrativa dello storyboard (story, listicle, before/after, hot take, etc.) è determinata dall'ad copy in input — tipicamente prodotto dalla skill `/ad-copy-writer` o `/video-script`. Lo storyboard NON inventa una struttura narrativa: la traduce in sequenza visiva.

**Dipendenza dal treatment**: lo storyboard NON può partire senza un `treatment.md` approvato dall'utente (GATE 1). Lo storyboard è la traduzione del treatment in sequenza temporale + sync VO.

### GATE 2 — Scene-VO Mapping (prima dello storyboard pieno)

Prima di scrivere lo SHOT DECK completo, presento all'utente una **tabella semplice** di mapping frase↔scena come anteprima dello storyboard. È un GATE separato dallo shot deck pieno: l'utente approva l'abbinamento PRIMA che io vada a dettagliare ogni scena.

Formato della tabella mapping (in chat, via markdown):

| # | voiceoverSegment (frase esatta del copy) | scena visiva (1 riga) | tipo | durata stimata |
|---|------------------------------------------|----------------------|------|----------------|
| 1 | "La tua azienda ha il CRM, WhatsApp..." | 4-panel comic split, 4 dipendenti isolati | AI-VID | ~6s |
| 2 | "Nella maggior parte delle aziende..." | Wide office vuoto al crepuscolo | AI-VID | ~3s |
| ... | | | | |

Regole della tabella mapping:
- Ogni riga = una scena del reel finale
- "voiceoverSegment" è una frase TESTUALE del copy (sarà usata per il sync VO↔scena)
- Numero di KINETIC-DASHBOARD dichiarato nel treatment guida la mappatura — se il treatment dice 0 dashboard, niente righe KINETIC-DASHBOARD qui
- L'utente può chiedere split (1 riga → 2 righe), merge, riformulazione, cambio tipo (KINETIC vs AI-VID), aggiunta/rimozione di scene
- Iterate finché l'utente approva esplicitamente. Poi vado avanti con lo SHOT DECK pieno.

### Processo (dopo GATE 2 approvato)

1. Leggere il `treatment.md` approvato
2. Convertire la tabella mapping approvata in SHOT DECK con tutti i dettagli (camera, transizioni, durata, visualPrompt completo, ecc.)
3. **HOOK GATE (obbligatorio)** — l'hook visivo dei primi 3 secondi è già definito frame-by-frame nel treatment (sezione 7). Lo storyboard lo traduce in 1-2 scene dello shot deck rispettando esattamente la descrizione del treatment. Se serve modificare l'hook → tornare al treatment, non improvvisare nello shot deck.
4. Assegnare a ogni shot: timing, tipo, provider, descrizione visiva, camera movement, transizione in uscita, eventuale testo overlay
5. Verificare il ritmo: ogni nuova frase o concetto del voiceover deve atterrare su un taglio
6. Eseguire la **checklist qualità** (vedi sotto) prima di presentare lo storyboard

### Output — SHOT DECK

```
SHOT DECK — [nome/titolo del reel]
---
Durata totale: [secondi]
Art Direction: [riferimento al blocco ART DIRECTION sopra]
Formato narrativo: [story | listicle | before/after | hot take | tutorial | testimonial]
Composizione Remotion: [basic | talkingHead | productShowcase | textOverlay]
Voce: [voice ID e tono — es. "ElevenLabs Daniel, tono narrativo documentario"]

HOOK VISIVO: [descrizione esplicita di cosa il viewer vede nei primi 3 secondi e perché ferma lo scroll]

| # | Time | Durata | Tipo | Provider | Camera | Continuità | Descrizione visiva | Testo overlay | Voiceover sync | Transizione out |
|---|------|--------|------|----------|--------|------------|-------------------|---------------|----------------|-----------------|
| 1 | 0:00 | 2s | AI-VID | Kling 3.0 | Dolly-in lento | — | [descrizione dettagliata] | **$65,000** | "[prime parole]" | hard cut |
| 2 | 0:02 | 3s | AI-VID | Kling 3.0 | Pan right | 🔗 sì | [descrizione] | | "[parole VO]" | cross-fade 0.4s |
| 3 | 0:05 | 2s | TEXT | Remotion | — | — | [design treatment] | [testo grande] | "[parole VO]" | hard cut |
...

Note regia:
- Hook: [perché questo hook funziona — quale pattern interrupt usa]
- Arco visivo: [es. "temperatura colore da blu freddo a oro caldo"]
- Beat emotivi chiave: [quali shot portano il peso emotivo e perché]
- Sync VO/visual: [note su timing critico tra voiceover e tagli]
---
```

### 🔴 REGOLA D'ORO: Sync video↔audio (no freeze)

**Validato 2026-04-26 su un reel cliente (voto 4/10) — errore "non pubblicabile".**

In `BasicReel.tsx`, ogni scena monta un `OffthreadVideo` per `durationInFrames` calcolata dal segmento audio (boundaries dei `voiceoverSegment` nei word-timestamps). Se il **clip Kling è più corto del segmento audio**, Remotion **freeza l'ultimo frame** mentre l'audio prosegue. Risultato: scene "morte" che si percepiscono come bug grave. Per il cliente è **bloccante** — qualsiasi reel con questo difetto NON è pubblicabile.

**Stage 1.5 — Auto-sync (dal 2026-05-26)**: la pipeline allinea automaticamente `durationSec` di ogni scena alla durata REALE del suo `voiceoverSegment` letta dai word-timestamps ElevenLabs, PRIMA di generare i clip Kling. Implementato in [src/utils/sync-durations.ts](src/utils/sync-durations.ts) e cablato in [src/pipeline.ts](src/pipeline.ts) tra Stage 1 (voiceover) e Stage 2 (Kling). Persiste lo script aggiornato sia nell'outputDir del reel sia nello script sorgente — il prossimo run parte già con i valori corretti. Risolve da solo il ~95% dei FREEZE.

**Guardie bloccanti (dal 2026-06-10)** — al run video (non in `--audio-only`, dove restano warning per permettere l'iterazione voce):
- **Scene con audio reale > 10s** → il run si FERMA prima di Stage 2 con le istruzioni di split (Kling 3.0 Pro genera max 10s per clip, vanno spezzate in 2 scene continuative). Override consapevole: `--allow-oversized`.
- **`voiceoverSegment` non trovato nei timestamps** → il run si FERMA con le cause tipiche (segment che non ricalca il voiceoverText parola-per-parola, audio tag in apertura del segment).

**Regola d'oro inviolabile**:

> Per ogni scena `AI-VID`, la durata del clip generato deve essere **≥ durata del segmento audio** mappato dal `voiceoverSegment`.

Vincoli operativi che derivano:

1. **Massimo per scena: 10 secondi di audio**. Kling 3.0 Pro genera max 10s in singola call (`getClipDuration` clampa a 10). Se un beat narrativo dura >10s di audio, **DEVE essere spezzato in 2-3 scene consecutive** sullo stesso filo narrativo (continuità o match-cut), ciascuna ≤10s.

2. **Audit clip riusati PRIMA di metterli in script.json**. Se riusi un clip da un reel precedente, esegui `ffprobe -v error -show_entries format=duration <file.mp4>` e confronta con la durata stimata del segmento audio. Se `clip < audio` → spezza il segmento o rigenera il clip. Esempi del fallimento v3:
   - `scene-9.mp4` (handshake) era 5s, ma copriva 14.6s di audio → freeze 9.6s
   - `scene-12.mp4` (bridge sealed) era 5s, ma copriva 11.7s → freeze 6.7s
   - `scene-15.mp4` (end card) era 10s, ma copriva 18s → freeze 8s

3. **Tabella sweet spot lunghezza scena vs audio**:

   | Audio segment | Strategia |
   |---------------|-----------|
   | ≤ 5s | 1 scena, `durationSec = audio_sec`, clip Kling 5-6s |
   | 5-10s | 1 scena, `durationSec = audio_sec`, clip Kling = `ceil(durationSec)+1` (max 10) |
   | 10-15s | **SPLIT in 2 scene** ~6-8s ciascuna su due beat visivi correlati (continuità o match-cut) |
   | 15-20s | **SPLIT in 2-3 scene** 6-8s ciascuna |
   | >20s | Riconsidera l'intera architettura — segmento troppo lungo per un singolo beat visivo |

4. **Long tableau cinematografici**: se la scena DEVE essere "tableau lento" (es. ufficio in timelapse, ponte burning) ma il copy dura 16-18s, NON tirarla artificialmente con freeze. Spezzala in 2 fasi visive distinte (es. day→night pt1 + pt2 con luce diversa, ristorante outsider esterno + interno) entrambe coerenti per palette/ambientazione.

5. **Quando spezzi, anche il `voiceoverSegment` va spezzato** in due substrings sequenziali del `voiceoverText` globale. Le prime 3 parole di ogni segmento NON devono iniziare con un audio tag (es. `[intrigued]`, `[curious]`) altrimenti il matcher fuzzy (che filtra i tag) fallisce e il pipeline interpola il timing introducendo offset di 0.3-1s. Il tag rimane nel `voiceoverText` globale ma fuori dal `voiceoverSegment`.

6. **Checklist prima di lanciare la pipeline** (obbligatoria):
   - [ ] Per ogni scena, `durationSec ≤ 10`
   - [ ] Per ogni clip riusato, `ffprobe duration ≥ stima audio del segmento`
   - [ ] Nessun `voiceoverSegment` inizia con `[tag]`
   - [ ] Somma stima audio scene ≈ durata `voiceover.mp3` (entro ±2s)
   - [ ] Se hai segmenti >12s, hai un piano di split documentato nello shot deck

**Eccezione consentita**: KINETIC component (durata libera, ma è un'animazione Remotion non un video, e gestisce internamente l'estensione della fase finale) e scene con `text` overlay statico (max 4s — vedi memory `feedback_reel_text_overlay_fail.md`).

### Tipi di shot disponibili

| Tipo | Provider | Cosa produce | Durata | Quando usarlo |
|------|----------|-------------|--------|---------------|
| `AI-IMG` | FLUX (fal.ai) | Immagine statica con Ken Burns zoom | qualsiasi | Scene descrittive, ambienti, establishing, dettagli |
| `AI-VID` | Kling 3.0 Pro (fal.ai) | Video clip 3-15s da immagine FLUX | 3-15s | Beat emotivi chiave, movimenti, azioni, transizioni dinamiche |
| `AI-VID-HERO` | Veo 3.1 (se disponibile) | Video clip premium 4K | fino a 8s | Lo shot singolo più importante del reel — max 1 per reel |
| `TEXT` | Remotion nativo | Schermo con testo animato word-by-word | 2-3s max | Pattern interrupt brevissimo, frasi chiave brevi. **Non usare come filler narrativo**: scritte statiche > 4s sono noiose e disengage totale (validato 2026-04-24 reel-4576 voto 4/10). |
| `KINETIC-NUMBER` | Remotion `KineticNumber` | Numero hero animato 4 secondi con 5 fasi (impact → settle → context reveal → breath → light sweep), particelle dorate, motion blur, parallax depth | **max 4s**, **max 1-2 per reel** | Pattern interrupt HERO per UN numero chiave (es. 391%, 40-60%, 78%). Produce stopping power molto superiore al `TEXT` piatto. Componente: [remotion/components/KineticNumber.tsx](remotion/components/KineticNumber.tsx). Props: `value`, `suffix`, `label`, `source`, `palette`. Demo standalone registrata come composition `KineticNumberDemo` in [remotion/Root.tsx](remotion/Root.tsx). |
| `KINETIC-DASHBOARD` | Remotion `KineticDashboard` | Schermata full-frame 9:16 con 1-3 pannelli dashboard stacked (trend / donut / bars). Numeri reali leggibili, count-up animato, sparkline / donut sweep / bar grow progressivi. Palette navy+brass on-brand. | **max ~5s per pannello** (3 pannelli ≈ 5s totali, 1 pannello ≈ 3s), **max 1-2 per reel** | UNICO modo affidabile per mostrare dashboard/KPI/grafici numerici in un reel. **Sostituisce categoricamente la generazione AI di schermi con dashboard** (Kling/Veo producono SEMPRE gibberish testuale negli schermi). Tagliare TO `KINETIC-DASHBOARD` quando il VO dice "report", "vedi i numeri", "tempo reale", "visione completa", o serve mostrare KPI hero. Componente: [remotion/components/KineticDashboard.tsx](remotion/components/KineticDashboard.tsx). Props: `panels[]` (array discriminato per `type: "trend"\|"donut"\|"bars"`), `palette` (opz). Demo standalone registrata come composition `KineticDashboardDemo` in [remotion/Root.tsx](remotion/Root.tsx). Validazione schema in [src/schemas/script.ts](src/schemas/script.ts) → `KineticDashboardSchema`. |
| `B-ROLL` | FLUX / stock | Immagine o video generico di contesto | qualsiasi | Transizioni, establishing, respiro visivo |

**Mapping tipo di shot → campi dello script.json** (lo schema NON ha un campo `shotType`: il tipo emerge dai campi compilati, mutuamente esclusivi):

| Tipo nello shot deck | Come si esprime nella scena dello script.json |
|---|---|
| `AI-VID` | `visualPrompt` compilato (+ `keyframe`/`videoMotionPrompt` se passato dallo storyboard) |
| `AI-VID-HERO` | `provider: "veo3"` + `visualPrompt` |
| `AI-IMG` / `B-ROLL` statico | `imageUrl` (+ `kenBurnsRange` opzionale) — `visualPrompt` vuoto |
| `TEXT` | `text` compilato — `visualPrompt` vuoto |
| `KINETIC-NUMBER` | `kinetic: { value, suffix, label, ... }` |
| `KINETIC-DASHBOARD` | `kineticDashboard: { panels: [...] }` |
| Dashboard animata complessa | `dashboardComponent: "<id-registry>"` |
| SPLICE (da ad originale) | `sourceClip: { file, startSec, endSec }` — tutto il resto vuoto |

**Note sui provider:**
- `AI-VID` default = Kling 3.0 Pro via fal.ai. Supporta image-to-video con first-frame E last-frame conditioning.
- `AI-VID-HERO` = Veo 3.1 per lo shot hero del reel. Qualità massima ma costo più alto e max 8s. Usare solo quando la qualità dello shot hero giustifica il costo.
- Se il progetto richiede volume alto a basso costo, sostituire Kling con MiniMax Hailuo (6-10s, prezzo ~30% inferiore).
- Per scene con movimento corporeo complesso (danza, sport, azione), Seedance 2.0 produce motion fidelity superiore.

### Dashboard animate (`dashboardComponent`) — recipe

**Quando**: dashboard BI/CRM **complessa** (funnel multi-step, scheda cliente con timeline+tag, board funnel+donut+barre+legenda, inbox, kanban) che `KINETIC-DASHBOARD` (1-3 pannelli stacked) non copre. Sostituisce il path statico "React → still PNG → `imageUrl` + Ken Burns" con una versione **animata** (count-up, reveal staggerato, donut sweep, barre che crescono). Validato sul pilot owner-animated (2026-06-01): l'animazione "fa atterrare i dati da soli" → dimostra il claim invece di descriverlo, nettamente superiore al PNG + Ken Burns.

**Tre regole d'oro** (come per KINETIC-DASHBOARD): mai far generare dashboard a Kling/Veo (producono sempre gibberish); mai overlay Remotion sopra clip Kling; numeri sempre dichiarati `[REAL/ILLUSTRATIVE/FROM COPY]`.

**Recipe** (è il modo in cui genero le dashboard da brief/copy, ora animate di default):

1. **Genera il componente** in [remotion/components/dashboards/](remotion/components/dashboards/)`<Nome>.tsx` usando SEMPRE le primitive di [remotion/utils/dashboard-motion.tsx](remotion/utils/dashboard-motion.tsx) — così è animato per costruzione, non a mano:
   - `ramp(frame, start, dur)` → progress 0→1; `fmtIt(n)` → numeri stile italiano
   - `useReveal(start, dur, dy)` / `<Reveal>` → opacità + slide-up staggerato
   - `useCountUp(target, start, dur)` / `<CountUp>` → numeri che salgono
   - `useGrow(start, dur)` + `<GrowBar>` → barre/funnel che crescono
   - `<DonutSweep segments reveal .../>` → donut snake-fill progressivo
   - Font da [remotion/utils/fonts.ts](remotion/utils/fonts.ts), mai font di sistema generici. **Per un reel CLIENTE: palette + font dal BRAND/landing del cliente, e MATCHA il font dei sottotitoli (Inter) — non un default fisso navy/brass+serif.** Un'estetica inventata generica (es. carta beige + serif Playfair) legge come "grafica AI/Claude" e viene bocciata (feedback cliente 2026-06-02). Estrai i token dalla landing: `curl` → hex `#xxxxxx` più citati + `font-family`/Google Fonts + screenshot dell'hero ritagliato a piena risoluzione.
2. **Registralo** in [remotion/components/dashboards/registry.ts](remotion/components/dashboards/registry.ts) con un id kebab-case (es. `"acme-owner"`).
3. **Nello script.json**: scena con `dashboardComponent: "<id>"` + `durationSec` + `voiceoverSegment`. Lascia `visualPrompt` e `text` vuoti. La scena **salta Stage 2** (no Kling, costo zero) e si sincronizza col voiceover via Stage 1.5 (durationSec dal segmento VO).

**Sottotitoli vs card (regola spazio, automatica)**: `BasicReel` calcola gli intervalli di frame delle scene `dashboardComponent` e li passa a `Subtitle` via la prop `hiddenIntervals` → mentre una card è a schermo il sottotitolo è **nascosto del tutto** (la card mostra già il suo testo, niente overlap), e le parole di confine restano visibili sulle scene video adiacenti. È **gating per frame**, non per parola: NON filtrare i sottotitoli per overlap (mangia le parole di confine) né per midpoint (le fa bleedare sulla coda della card). Non serve fare nulla a mano, vale per ogni `dashboardComponent`.

**Zoom Ken Burns continuo (`kenBurnsRange`)**: per le scene `imageUrl` il campo opzionale `kenBurnsRange: [start, end]` (schema → `BasicReel` → `BackgroundImage.zoomRange`, default `[1, 1.15]`) controlla lo zoom. Per due scene **consecutive con la STESSA immagine** (es. una cover su due frasi di VO) incatena i range — `[1.0, 1.085]` poi `[1.085, 1.17]` — per uno zoom **continuo** invece di due zoom-in ripetuti che sembrano la stessa scena spalmata in due.

**Timing**: le primitive del POC sono tarate per ~130 frame di reveal (≈4.3s) poi "respiro" che riempie il resto. Dimensiona il `voiceoverSegment`/`durationSec` della scena a **≥5s** così il reveal completa. Se il segmento VO è più corto, comprimi i `delay`/`dur` nel componente (sono tutti parametrici).

**Differenza con gli altri shot type dashboard**:
- `KINETIC-NUMBER` → UN numero hero (391%). `KINETIC-DASHBOARD` → 1-3 pannelli metrici stacked (trend/donut/bars), schema JSON. `dashboardComponent` → layout BI/CRM **arbitrario e complesso**, espresso come componente React (non serializzabile in JSON), montato full-frame da BasicReel. Per dashboard semplici resta preferibile `KINETIC-DASHBOARD` (no codice nuovo); usa `dashboardComponent` solo quando il layout supera i 3 pannelli stacked.

### Movimenti camera disponibili (Kling 3.0)

Ogni shot `AI-VID` DEVE specificare un movimento camera nella colonna "Camera". Kling 3.0 riconosce questi termini:

| Movimento | Effetto | Quando usarlo |
|-----------|---------|---------------|
| `Dolly-in` | Avvicinamento al soggetto, con parallasse | Momenti emotivi, realizzazioni, tensione crescente |
| `Dolly-out` | Allontanamento dal soggetto | Reveal, apertura, risoluzione |
| `Pan left/right` | Panoramica orizzontale | Establishing, ambienti, transizioni |
| `Tilt up/down` | Panoramica verticale | Reveal verticale, architettura, skyline |
| `Zoom in/out` | Avvicinamento senza parallasse | Enfasi, focus su dettaglio |
| `Crane up/down` | Movimento verticale della camera | Aperture epiche, establishing dall'alto |
| `Rack focus` | Cambio fuoco foreground/background | Spostamento attenzione tra soggetti |
| `Statico` | Nessun movimento | Paralisi, tensione, momenti di pausa |
| `Handheld` | Leggero shake naturale | Intimità, immediatezza, POV |

**REGOLA**: mai lasciare la colonna Camera vuota su un AI-VID. Kling senza istruzioni camera produce shot statici (praticamente un'immagine) — fallimento garantito.

### Transizioni disponibili (Remotion TransitionSeries)

Ogni shot specifica la transizione IN USCITA nella colonna "Transizione out":

| Transizione | Effetto | Quando usarla |
|-------------|---------|---------------|
| `hard cut` | Taglio secco, nessun effetto | **Default**. Usa questo nel 80%+ dei casi |
| `cross-fade 0.4s` | Dissolvenza incrociata (12 frame) | Solo tra scene narrative dello stesso momento emotivo |
| `slide-up` | Scena successiva entra dal basso | Transizione verso TEXT overlay, reveal dato |
| `wipe-left` | Scena successiva copre da destra | Passaggio temporale, cambio location |
| `fade-black` | Fade a nero e ritorno | Ellissi temporale ("5 mesi dopo"), separazione atti |

**Hard cut è il default.** Le altre transizioni sono eccezioni motivate. Se più del 20% degli shot usa transizioni diverse da hard cut, il reel perde il ritmo.

### Regole Storyboard

#### Hook (primi 3 secondi)
- **L'hook visivo è obbligatorio e deve essere descritto esplicitamente** nel campo HOOK VISIVO dello shot deck. Se manca un'idea forte per l'hook visivo, FERMARSI e chiedere — non procedere mai con uno shot generico.
- L'hook è due cose contemporaneamente: cosa si DICE (copy) + cosa si VEDE (visual). Entrambe devono essere forti.
- Pattern interrupt visivi efficaci per l'hook: numero grande in gold, close-up mani/oggetto con luce drammatica, testo bold su nero, immagine controintuitiva, before/after estremo.
- MAI aprire con un establishing shot generico (skyline, ufficio vuoto, persona che cammina). Il primo frame è il frame che ferma lo scroll o che fa perdere il viewer.

#### Pacing e ritmo
- Alternare shot brevi (1-2s) per energia e shot più lunghi (3-5s) per respiro. Mai 3+ shot della stessa durata consecutivi.
- **Durata shot**: min 1s (rapid montage), max 15s (limite Kling 3.0 singola generazione). Sweet spot per reel: 2-3s per shot.
- I TEXT shot funzionano come pattern interrupt visivi — spezzano il flusso cinematografico e rimettono a fuoco le parole chiave. Distribuirli ogni 3-5 shot visivi.
- **Regola del 80/20**: almeno 80% degli shot sono AI-IMG o AI-VID. Max 20% TEXT puro. I reel troppo "testuali" performano peggio.

#### Video (AI-VID)
- Il movimento video (dolly, pan, zoom) deve coincidere con i beat emotivi più forti dello script. Non sprecare AI-VID su scene statiche — usa AI-IMG + Ken Burns.
- Ogni AI-VID ha un costo di generazione. Budget: max 5-6 clip AI-VID per reel di 60s. Usarli chirurgicamente sui momenti che DEVONO muoversi.
- **Multi-shot nativo**: Kling 3.0 supporta storyboard di 2-6 scene in una singola generazione con coerenza visiva. Per sequenze narrative (es. 3 shot della stessa scena con angoli diversi), segnalare "MULTI-SHOT GROUP" nelle note regia per generarli insieme.

#### Continuità tra scene (colonna "Continuità")

La colonna **Continuità** nello shot deck controlla se una scena deve iniziare visivamente dall'ultimo frame della scena precedente, eliminando gli stacchi visivi.

**Valori possibili:**
- `—` (default): la scena è generata in modo indipendente (text-to-video)
- `🔗 sì`: la scena usa l'ultimo frame della scena precedente come first-frame (image-to-video)

**Come funziona nel codice:**
1. La scena precedente viene generata normalmente (text-to-video)
2. Il suo ultimo frame viene estratto con ffmpeg
3. La scena con continuità viene generata con image-to-video, usando quel frame come punto di partenza
4. Il visualPrompt guida il movimento e la trasformazione della scena a partire da quel frame

**Regole:**
- La **prima scena** non può mai avere continuità (non c'è un frame precedente)
- Le scene **TEXT** non producono video, quindi la continuità salta alla scena video precedente più vicina
- La continuità ha impatto sulla velocità: le scene con `🔗 sì` vengono generate **sequenzialmente** (non in parallelo), aggiungendo ~2-3 min per scena con continuità
- Usare la continuità **solo dove serve narrativamente**: stessa location con cambio angolazione, sequenze temporali fluide, movimenti continui. Non su ogni scena — l'alternanza tra stacchi e continuità crea ritmo
- Quando una scena ha continuità, il **visualPrompt** deve descrivere la trasformazione/evoluzione dalla scena precedente, non una scena completamente diversa
- La continuità funziona meglio con **cross-fade** o **hard cut** come transizione

**Esempio di uso efficace:**
```
| 3 | 0:06 | 3s | AI-VID | Kling 3.0 | Dolly-in  | —      | uomo seduto alla scrivania, golden hour... |
| 4 | 0:09 | 3s | AI-VID | Kling 3.0 | Pan right | 🔗 sì | la camera si sposta lentamente a destra, rivelando la finestra panoramica... |
| 5 | 0:12 | 2s | TEXT   | Remotion  | —         | —      | **Il cambiamento inizia qui** |
| 6 | 0:14 | 3s | AI-VID | Kling 3.0 | Dolly-out | —      | nuova scena: esterno città al tramonto... |
```
Scene 3→4: continuità (stessa location, la camera si muove). Scena 5: testo (interrompe). Scena 6: scena indipendente (nuovo contesto).

#### Reel multi-personaggio (talk show, sketch) — geografia condivisa obbligatoria

Lezione di un reel talk-show cliente (2026-06-12, bocciato: "il GHL sembra un vero talk show, il tuo un video AI fake"). Clip 1-personaggio-isolato sommate NON fanno una scena condivisa — 4 difetti che insieme producono l'effetto "AI fake":

1. **Geografia assente** (strutturale): ogni keyframe single-character mette l'attore da solo nel suo "mondo". Fix: **set master condiviso** — genera PRIMA un keyframe master del palco completo (tutti gli ospiti in fila, disposizione fissa, via `gen-variant --ref` multipli); ogni inquadratura successiva è un derivato coerente ("close-up di X, Y visibile sfocato sul bordo"). Wide establishing a inizio reel + wide di reazione + wide col movimento (es. valletta che passa DAVANTI alla fila).
2. **Trim audio secco**: tagliare le clip sull'attacco/coda voce taglia applausi/risate/room tone → l'ambience "salta" a ogni cut. Fix: **audio L-cut dai full-take** — il video si taglia, l'audio si estende 1-2s oltre il cut (dai full-take non trimmati) con crossfade 0.5-1s sotto la scena successiva. Conservare SEMPRE i full-take.
3. **Color grading per-clip**: ogni generazione ha palette/contrasto suoi. Fix: **grade comune in post** (un look unico curves/LUT su tutto il reel).
4. **Tagli imprecisi**: parole appese a inizio/fine scena. Fix: dopo il trim, **ri-trascrivere i file tagliati** (whisper) per beccare parole appese — i margini IN/OUT dai word-timestamps non bastano.

Dove serve la dinamica tra due attori (accusa→interruzione): genera UNA clip 8s con camera move tra i due ("camera pans from her to him") invece di 2 clip isolate — continuità intrinseca di grading/audio/spazio (pilota economico prima di scalare: multi-speaker in un clip è il punto debole noto).

#### Ad comiche/parodia — la comicità non colpisce MAI l'avatar

Lezione di un reel talk-show cliente (2026-06-11): la joke "Tanto sei sempre stato un TIRCHIO!" rivolta al protagonista-imprenditore è anti-copy — il viewer si identifica col protagonista, ogni battuta che lo colpisce colpisce il prospect.

1. Heckler/pubblico = **UN solo partito, contro il protagonista**, finché non c'è la scena di conversione esplicita ("detta così…" / "farei uguale"). Dopo, cambiano partito tutti insieme — la polarità unica rende leggibile la dinamica.
2. La **joke finale ridicolizza un antagonista** (es. la ex in negazione: "Tanto mi richiama!"), MAI il protagonista o una sua scelta.
3. Test per ogni battuta: "chi è il bersaglio? il viewer può sentirsi quel bersaglio?" Se il bersaglio è l'avatar → riscrivere.
4. Adattando USA→ITA verificare che il frame culturale regga ("cheap" = furbo nel frame USA del risparmio; "tirchio" in italiano è solo un insulto).

Vale anche per /video-script, /ad-copy-writer, /refresh-creativo.

#### Testo overlay
- Bold, leggibile. Mai nel top-right (zona profilo IG/TikTok). Mai sovrapposto a un volto.
- Numeri e dati chiave in gold #FFD700 — i numeri sono pattern interrupt naturali.
- Posizione default: lower-third con gradient overlay scuro dal basso.

#### Sync voiceover
- Ogni nuova frase o concetto del voiceover deve atterrare su un taglio. Lo storyboard deve indicare le **parole esatte** del VO che corrispondono a ciascuno shot.
- Il timing degli shot è una stima — la durata finale viene ricalibrata DOPO la generazione del voiceover ElevenLabs (che restituisce la durata esatta).

#### Descrizioni visive (colonna "Descrizione visiva")
- Ogni descrizione DEVE essere scritta come un prompt di alta qualità per FLUX/Kling. Non è una nota registica — è il prompt letterale che genera l'asset.
- **Includere sempre**: soggetto, ambiente, lighting specifico, camera angle, mood, 2-3 colori HEX dalla palette, "9:16 vertical composition", texture (es. "35mm film grain").
- **NON scrivere** prompt vaghi ("nice office", "happy person", "modern city"). Scrivere prompt cinematografici: "modern glass office interior, golden hour light streaming through floor-to-ceiling windows, shallow depth of field, warm tones #E8D5B7 and #1A1A2E, shot from eye level, 35mm film grain, 9:16 vertical".

### Anti-pattern — Errori che producono artefatti

Questi errori causano fallimenti sistematici nella generazione. Controllare OGNI shot prima di finalizzare:

| Anti-pattern | Problema | Soluzione |
|-------------|----------|-----------|
| **Testo leggibile chiesto al modello VIDEO (t2v, o i2v senza keyframe controllato)** | Kling/Veo via prompt generano SEMPRE testo illeggibile, distorto o sbagliato. Se il significato della scena dipende da parole visibili (notifica, timbro, saldo, form, insegna), la scena fallirà | **Mai far DISEGNARE il testo al modello video.** Se il testo è essenziale alla scena → recipe **TEXT-IN-SCENE** (sotto, validata 2026-06-11): il testo nasce perfetto nel keyframe Gemini e Kling i2v lo preserva. Se il testo NON è essenziale → concept visivo che comunica senza testo: reazione di una persona, gesto, luce, oggetto simbolico |
| **Schermi, monitor, smartphone visibili (senza keyframe controllato)** | Un device con schermo SENZA keyframe implica contenuto inventato dal modello: artefatti, testo illeggibile, interfacce assurde, orientamento sbagliato (laptop al contrario, telefono rovesciato) | Due vie: (a) contenuto dello schermo NON necessario al messaggio → **nascondere lo schermo**: persona illuminata DALLA LUCE dello schermo, schermo di spalle, close-up su reazione, silhouette controluce col glow; (b) contenuto necessario → recipe **TEXT-IN-SCENE** con keyframe + `--ref=` screenshot UI renderizzato (testo del viewer = grande) |
| **Dashboard, wall display, monitor con grafici/KPI** | Caso particolare del precedente: anche con prompt esplicito "no readable text, no numbers, just abstract shapes" Kling/Veo riempiono SEMPRE i pannelli con numeri gibberish, etichette nonsense, grafici random. Validato 2026-05-25 su un reel cliente: testo tipo "132110K", "T2401C", "S2151" generato anche con prompt anti-testo esplicito. Tentativo di "patchare" con overlay Remotion sopra i pannelli AI non scala (richiede pixel-measurement + clip-path per scena, prospettiva diversa ogni shot, fragilissimo). | **Non far generare dashboard a Kling/Veo da prompt. Mai.** Per il **data moment full-frame** (numeri che animano, KPI hero) → shot type `KINETIC-DASHBOARD`/`dashboardComponent` come scena separata, pattern di transizione: AI-VID close-up volto + brass glow → CUT → dashboard 3-5s → CUT → scena AI. Per lo **schermo in prospettiva DENTRO la scena** (laptop/monitor visto di lato col contenuto che deve restare leggibile) → recipe TEXT-IN-SCENE: keyframe con `--ref=` screenshot UI renderizzato, testo del viewer grande. Il VO si distribuisce fluido sui tagli. |
| **Documenti, contratti, timbri (senza keyframe controllato)** | Qualsiasi documento implica testo. Timbri come "DECLINED" o "APPROVED" generati da prompt saranno sempre illeggibili o assurdi | Se le parole sul documento sono il messaggio → recipe **TEXT-IN-SCENE** (foglio manoscritto validato). Altrimenti **sostituire con azione o simbolo**: cartella spinta via da una mano, pila di fogli che cade, porta che si chiude, busta sigillata. L'emozione passa dal gesto |
| Close-up estremo di volti | Artefatti facciali frequenti con AI | Preferire medium shot o close-up su mani/oggetti. Se serve un volto, usare shallow DOF per sfumare i dettagli |
| Troppi elementi nel prompt | Il modello si sovraccarica, ignora parti del prompt | Max 6-8 elementi descrittivi per prompt. Un soggetto, un ambiente, una luce |
| Camera movement non specificato | Kling produce shot statico (immagine che non si muove) | SEMPRE specificare il movimento nella colonna Camera |
| Movimento vago ("something moves") | Generazione bloccata o casuale | Usare terminologia cinematografica precisa: "slow dolly-in", "pan left to right" |
| Prompt spaziale ambiguo | Distorsioni prospettiche | Specificare "shot from eye level", "overhead shot", "low angle" — mai lasciare implicito |
| Shot consecutivi incoerenti | Personaggio cambia aspetto tra scene | Usare multi-shot group Kling 3.0 o specificare descrizione identica del soggetto |

#### Principio fondamentale: l'emozione passa dal visivo, non dal testo

I modelli generativi eccellono in: luce, composizione, ambienti, texture, gesti, espressioni, movimento camera, atmosfera.
I modelli VIDEO falliscono SEMPRE nel **disegnare da prompt**: testo leggibile, interfacce, numeri, loghi, dashboard.

**Quando pianifichi una scena, chiediti: "Se tolgo tutto il testo da questa immagine, il significato emotivo arriva comunque?"** Se sì, preferisci la scena senza testo (più cinematografica). Se no — il testo È il messaggio (lavagna col piano, foglio coi nomi, schermo con la notifica) — NON ripiegare su overlay Remotion sopra il clip (sembra una caption, validato 2026-04-24): usa la recipe TEXT-IN-SCENE qui sotto.

#### TEXT-IN-SCENE — testo diegetico leggibile (recipe validata 2026-06-11)

Il testo NON viene disegnato dal modello video: **nasce perfetto nel keyframe** (Gemini 3 Pro Image, il miglior text-renderer sul mercato, anche in italiano) **e Kling 3.0 Pro i2v lo preserva** se il motion prompt rispetta le regole sotto. Validato 4/4 al primo colpo su: lavagna in gesso (8 parole), foglio manoscritto corsivo, schermo laptop con notifica, schermo laptop con UI CRM completa (kanban 3 colonne, 10+ stringhe) — testo leggibile e stabile dal primo all'ultimo frame su clip 5s.

**Procedura** (usa l'infrastruttura esistente, nessun campo nuovo):

1. **Keyframe col testo esatto** — via Stage 1.7 storyboard o `npx tsx scripts/gen-variant.ts`. Nel prompt IMMAGINE il testo va tra virgolette esatte: `handwritten white chalk text reads exactly "PIANO B: vendere ai clienti che hai già"`. Regole: testo grande e ad alto contrasto, superficie frontale o quasi, + divieti UI fantasma (`full-frame candid cinematic photograph, NOT a phone screenshot, no camera app UI, no status bar`).
   - **Schermo con UI vera**: renderizza lo screenshot (Playwright/Remotion/HTML, font grandi) e passalo come reference: `--ref=<ui.png>` + prompt `the laptop screen displays EXACTLY the CRM interface shown in the reference image, all text crisp and legible`. Gemini la proietta in prospettiva nello schermo. Limite validato: il testo grande resta fedele, il micro-testo può driftare (es. "E-commerce"→"E-cemmercs") — **il testo che il viewer deve leggere va grande**, il micro-testo è solo texture.
2. **Vision-verify del keyframe** (parte del GATE 4): Read del PNG — il testo è ESATTO carattere per carattere? Niente UI fantasma? Errori qui costano $0.10, dopo $0.50+.
3. **i2v Kling 3.0 Pro** col keyframe (`keyframe:` nello script.json, o `scripts/test-text-i2v.ts` per test). Il `videoMotionPrompt` descrive SOLO il movimento + l'ordine di congelamento: `The text/screen remains EXACTLY unchanged, perfectly legible for the entire clip` — **MAI ripetere il CONTENUTO del testo nel motion prompt** (il modello tenterebbe di ridisegnarlo e lo corrompe). Camera statica o dolly-in lento; la vita della scena va LONTANO dal testo (persone sfocate sullo sfondo, polvere nella luce, breeze sul bordo del foglio, micro-gesti del soggetto). Clip 5s.
4. **Verify post-video**: frame a 0/50/100% (`ffmpeg -ss`) → il testo è identico al keyframe? In produzione: `pnpm scene-map --vision` (L2) lo copre.

**Limiti e fallback**:
- Movimento aggressivo (orbit, handheld marcato, zoom forte) non validato → rinforzo disponibile: `end_image_url` = stesso keyframe (ancora doppia start+end, già supportata via `tailImagePath`/`lastFrameImagePath`); fallback finale: still + `kenBurnsRange` (testo perfetto per costruzione, max 1-2 scene per reel — vedi feedback_reel_avoid_still_slideshow).
- Soggetto che INTERAGISCE col testo (mano che scrive in camera) non validato — evitare o splittare (scena gesto + scena testo).
- **Veo 3.1 per testo diegetico = NO** (gibberish/sottotitoli fantasma documentati — MIT Tech Review 2025; le guide ufficiali Google non trattano il testo in scena).
- `KINETIC-DASHBOARD`/`dashboardComponent` restano la via per **data moment full-frame** (numeri che animano, leggibilità 100%); TEXT-IN-SCENE copre il caso diverso: il testo deve vivere DENTRO la scena cinematografica (lavagna, foglio, schermo in prospettiva).
- Costi: keyframe ~$0.06-0.10 (iterabile), clip ~$0.50. Helper test A/B: [scripts/test-text-i2v.ts](scripts/test-text-i2v.ts) (`--end-anchor` per l'ancora doppia).

### Keyframe Gemini — failure mode e contromisure (Stage 1.7)

Gotcha ricorrenti della generazione keyframe con `gemini-3-pro-image-preview` (validati su reel cliente reali (2026-06-02, 2026-06-09, 2026-06-12)):

| Failure mode | Sintomo | Contromisura |
|---|---|---|
| "Luce/raggio" → lampada reale | "a beam of light from the book" → lampada da tavolo | Dichiara la fonte e VIETA le lampade: *"the open book is the ONLY light source... ABSOLUTELY NO desk lamp, reading lamp, floor lamp, ceiling light"* |
| UI fantasma su 9:16 scuro | status bar iPhone / orologio finti ("Verizon 8:45 PM") | Nel prompt: *"full-frame cinematic photograph, NOT a phone screenshot, no status bar, no clock, no battery/signal icons, no UI chrome"*; se persiste → patch via PIL (fill colore + blur) |
| "iPhone-style" → screenshot | la convenzione "iPhone-style photo" a volte rende uno SCREENSHOT con status bar + toolbar Markup (intermittente) | Per scene a rischio: **"candid photograph / candid cinematic photograph"** + divieti UI espliciti + "full-bleed photograph edge to edge" |
| Reference Pinterest troppo letterale | la ref guida anche genere/posa/composizione (2 scene stessa ref = quasi identiche) | Usa la ref solo per la "vibe"; per composizioni diverse TOGLI la ref e guida col prompt |
| Alcol filtrato dal safety filter | "two glasses of sparkling wine" → prompt filtrato, $0 ma FAIL | Riformula senza nominare l'alcol: "raising two glasses in a happy celebratory toast" |
| Volto incoerente tra scene | identità che drifta senza consistency test | `keyframeReferenceUrl: "assets/keyframes/scene-N.png"` → keyframe canonico LOCALE come ref su TUTTE le scene con quel soggetto (l'hash include la ref → cache miss → rigenera). Il prompt forte gestisce contesto/luce, la ref tiene il volto |
| Card Remotion riusata = testo vecchio | i `dashboardComponent` hanno il copy HARDCODED nel TSX | Duplica il componente col nuovo testo, registra in registry.ts, aggiorna lo script, `--sync-only` + render |
| "photograph" + "shot on Arri Alexa Xmm" → watermark/date-stamp di testo | Gemini stampa "Shot on Arri Alexa 35mm, Oct 26 5:12 PM" o "OCT 24, 2023" come watermark/timestamp sul bordo (intermittente, validato su un reel cliente 2026-06-15) | Usa **"cinematic film still"** invece di "photograph", TOGLI la frase del corpo macchina (no "shot on Arri Alexa Xmm" → "eye-level/three-quarter angle, shallow DOF") + negativi **"no text, no date stamp, no timestamp, no watermark"** |
| Camera-app UI iPhone su candid scuro | overlay LIVE/otturatore/flash/timer ("23:45") in basso (validato su un reel cliente scene 8/13) | "film still" + **"no phone screen UI, no camera app overlay, clean frame edges"** (stessa famiglia di "UI fantosma") |
| Scena di gruppo/orizzontale ruotata di 90° | tavolo+persone reso "di lato" (composizione landscape stipata in 9:16 e ruotata) | Aggiungi **"upright vertical portrait orientation, not rotated, level horizon"** + inquadra verticale ("people standing and leaning around the table") |
| Etnia di default non-italiana | volti asiatici/generici su prompt senza etnia (es. "two candidates" → due donne asiatiche) | Per ad mercato italiano dichiara **"Italian"** sui soggetti (es. "two near-identical Italian businessmen", "an Italian HR team") |
| Scena di gruppo "fake"/da stock | troppo simmetrica, tutti vestiti uguali, posa innaturale (bocciata da Michel su un reel cliente) | **"real office, candid documentary feel, varied business-casual clothing in different colours, relaxed asymmetric composition, people at different distances"**; evita overhead simmetrico e CV "fanned like cards" |

**STYLE_ANCHOR di default** (`gemini-image.ts` appende a OGNI prompt *"Photoreal style iPhone photography... NO 3D render..."*): giusto per il photoreal italiano standard, ma per progetti **non-fotoreali** (clay, anime, 3D) o con **lighting di progetto forte** (studio TV tungsten+gel, VHS, neon, club) l'anchor litiga col prompt → stili incoerenti tra asset o resa plasticosa. Fix: `gen-variant.ts --no-anchor` (+ blocco fotografico di progetto NEL prompt, es. *"shot on professional broadcast television camera, realistic skin texture with visible pores, subtle broadcast video grain, NOT CGI"*) oppure override env `GEMINI_IMAGE_STYLE_ANCHOR`. Character sheet di 2+ personaggi: genera il 1° libero, gli altri con `--ref=<primo>` + prompt "usa il riferimento SOLO per materiale/finitura/luce, NON per il volto".

**Shot simbolici a rischio kitsch** (es. "raggio di luce dal libro alla testa"): NON tirare a indovinare con un prompt solo — genera **N varianti in parallelo** con direzioni creative diverse, ogni agente auto-verifica la propria immagine via vision (2-3 iterazioni), poi scegli la migliore affiancandole. Helper: `npx tsx scripts/gen-variant.ts "<visualPrompt>" "/tmp/out.png"`. Un keyframe simbolico bello NON va lasciato statico per paura di Kling: spesso l'i2v rende il simbolismo MEGLIO della statica — `videoMotionPrompt` SOTTILE ("gently flows and shimmers... do not break or distort").

### Checklist qualità (eseguire PRIMA di presentare lo storyboard)

- [ ] **Hook**: l'hook visivo è descritto esplicitamente? È un pattern interrupt reale, non un establishing generico?
- [ ] **🔴 Sync video↔audio**: per OGNI scena AI-VID, la durata stimata del segmento audio è ≤ 10s? Per ogni clip riusato, `ffprobe duration ≥ audio segment`? Nessun `voiceoverSegment` inizia con `[tag]`? Vedi sezione "REGOLA D'ORO: Sync video↔audio" sopra. **Errore non negoziabile**: clip che freezano sull'ultimo frame mentre l'audio prosegue rendono il reel non pubblicabile.
- [ ] **Pacing**: nessuna sequenza di 3+ shot con la stessa durata?
- [ ] **Camera**: ogni AI-VID ha un movimento camera specificato?
- [ ] **Testo in scena = solo via TEXT-IN-SCENE**: per ogni scena visiva, chiediti "se tolgo tutto il testo da questa immagine, il significato emotivo arriva comunque?" Se sì → preferisci la versione senza testo. Se no (il testo È il messaggio) → la scena segue la recipe TEXT-IN-SCENE (keyframe col testo esatto + vision-verify + motion prompt che congela il testo senza citarne il contenuto). MAI testo affidato al prompt video t2v, MAI overlay Remotion sopra il clip.
- [ ] **Schermi frontali = solo con keyframe controllato**: ogni scena con schermo/monitor/smartphone frontale ha un keyframe TEXT-IN-SCENE (eventualmente con `--ref=` screenshot UI)? Se il contenuto dello schermo non serve al messaggio, meglio nasconderlo (luce dello schermo sul volto, schermo di spalle).
- [ ] **Schermi-con-dati in AI-VID**: per OGNI scena AI-VID il cui visualPrompt descrive schermo/dashboard/wall display con contenuto visibile → tre opzioni mutuamente esclusive: (a) nascondere lo schermo (off-camera + brass glow on face, schermo di spalle) → resta AI-VID semplice; (b) **data moment full-frame** (grafici che animano, KPI hero) → `KINETIC-DASHBOARD`/`dashboardComponent` (svuotare visualPrompt); (c) **schermo in prospettiva DENTRO la scena** con testo che deve restare leggibile → TEXT-IN-SCENE (keyframe + ref UI). Mai overlay Remotion sopra clip Kling. Il discriminatore NON è cosa dice il VO, è cosa stai per chiedere a Kling di disegnare.
- [ ] **Prompt quality**: ogni descrizione visiva ha soggetto + ambiente + lighting + camera angle + colori HEX?
- [ ] **80/20**: almeno 80% degli shot sono AI-IMG o AI-VID?
- [ ] **Budget AI-VID**: max 5-6 clip video per reel 60s?
- [ ] **Transizioni**: almeno 80% hard cut? Le eccezioni sono motivate?
- [ ] **Sync VO**: ogni shot ha le parole esatte del voiceover corrispondente?
- [ ] **Anti-pattern**: nessuno degli errori nella tabella anti-pattern è presente?
- [ ] **Continuità**: la colonna Continuità è compilata per ogni riga (— o 🔗 sì)? La prima scena ha —? Le scene con 🔗 sì hanno un visualPrompt che descrive una trasformazione dalla scena precedente, non una scena nuova?
- [ ] **Scopo**: ogni shot ha una ragione per esistere? Se non sai perché è lì, taglialo.

### Sistema feedback (in costruzione)

Lo storyboard migliora nel tempo tramite feedback sui reel prodotti. Il ciclo è:

1. Reel prodotto → utente assegna voto da 1 a 10
2. Per voti ≤ 5: annotare in `memory/context.md` cosa non ha funzionato (shot specifico, errore di pacing, hook debole, artefatto visivo, etc.)
3. Per voti ≥ 8: annotare cosa ha funzionato particolarmente bene
4. Le annotazioni diventano regole emotive nel tempo (es. "per story reel, il dolly-in sul momento di crisi produce sempre voti alti")

Fino a quando non ci saranno abbastanza dati, le regole emotive restano non codificate — lo storyboard si basa sull'art direction e sulle regole strutturali sopra.

---

## FASE 3 — Generazione script.json

**Quando**: DOPO lo storyboard approvato.

### 🎚️ FORMAT AUDIO — decisione obbligatoria a monte (`audioMode`)

Esistono **due format mutuamente esclusivi, NIENTE ibrido** (deciso 2026-06-01). Imposta SEMPRE il campo top-level `audioMode` nello script.json — non lasciarlo derivare:

| `audioMode` | Provider scene video | Audio | Quando | Voiceover |
|-------------|----------------------|-------|--------|-----------|
| `"elevenlabs"` | `kling` (default) / `heygen` | Voiceover ElevenLabs esterno (Stage 1) | Reel narrati con voice-over (caso standard) | `voiceoverText` o `voiceoverSegments` **obbligatorio** |
| `"veo-native"` | `veo3` su **tutte** le scene video | Audio italiano nativo embedded nei clip Veo (campo `dialogue` per scena) | Reel con **attori** che parlano in scena | **Vietato** voiceoverText/Segments (→ doppio audio) |

**Guardia anti-errore (cablata nel codice, non opzionale)**: `resolveAudioMode()` in [src/pipeline.ts](src/pipeline.ts) + `.superRefine` in [src/schemas/script.ts](src/schemas/script.ts) **bloccano** con errore esplicito, PRIMA di qualsiasi call API:
- reel **ibridi** (scene video che mischiano `veo3` con `kling`/`heygen`) → niente doppio audio per sbaglio;
- `audioMode` dichiarato **incoerente** coi provider delle scene;
- `elevenlabs` senza voiceover, o `veo-native` con voiceover residuo.

In `veo-native` lo Stage 1 (ElevenLabs) **non parte proprio** — niente call sprecata, niente `--skip-voiceover` da ricordare. In `elevenlabs` non viene mai attivato Veo di nascosto. Il default di `provider` resta `kling`: per un reel-attori ricordati `provider: "veo3"` su OGNI scena video + `audioMode: "veo-native"`.

**Processo**:
1. **Scegli `audioMode`** (`elevenlabs` o `veo-native`) in base alla tabella sopra e impostalo come campo top-level dello script.json
2. Tradurre lo SHOT DECK in un oggetto JSON conforme a `ReelScriptSchema`
3. Ogni riga dello shot deck diventa una entry nell'array `scenes`. In `veo-native`: `provider: "veo3"` su ogni scena video + `dialogue`/`speaker`/`dialogueLang` per le battute
4. Il campo `visualPrompt` di ogni scena incorpora: la descrizione visiva dallo storyboard + le direttive dall'art direction (palette, lighting, texture, environment)
5. Il campo `text` è il testo overlay dallo storyboard
6. Il campo `continuity` è `true` se la colonna Continuità dello shot deck è "🔗 sì", altrimenti `false` (o omesso)
7. In `elevenlabs`: il `voiceoverText` è il testo completo del voiceover, concatenato in ordine (in `veo-native` va omesso)
8. Lo `style` viene scelto in base al tipo di reel (default: "basic")

**Template visualPrompt di alta qualità** (usare come base per ogni scena):
```
[soggetto principale], [ambiente/location], [lighting dal blocco art direction],
[composizione/camera angle dallo storyboard], [mood/emozione],
[texture/trattamento dal blocco art direction], [colori palette HEX],
shot on [riferimento camera/lente], [formato] 9:16 vertical
```

**Esempio**:
```
"visualPrompt": "businessman in his late 30s sitting alone on a modern apartment balcony at dusk, Dubai Marina skyline in background, golden hour sidelight from left at 45 degrees with long shadows, medium shot eye-level shallow depth of field, contemplative and vulnerable mood, slight 35mm film grain with selective desaturation, warm tones #E8D5B7 and deep navy #1A1A2E, shot on Arri Alexa 50mm lens, 9:16 vertical composition with subject in left third"
```

---

## FASE 4 — Voice generation + GATE 3 (Voice Approval)

**Quando**: DOPO il script.json. PRIMA dello step Kling+Render irreversibile.

**Filosofia**: il voiceover ElevenLabs è l'asse temporale del reel — Stage 1.5 della pipeline ricalibra `durationSec` di ogni scena sull'audio reale, quindi un voiceover sbagliato propaga errori in CASCATA sul timing di tutte le scene. Iterare sull'audio costa $0.30 e 30 secondi, iterare DOPO Kling costa $7 e 30 minuti. Il gate vive QUI.

**Comando**:
```bash
pnpm reel "path/to/script.json" --audio-only
```

Output: cartella reel con `assets/voiceover.mp3` + `word-timestamps.json`. Niente Kling, niente Remotion.

**Cosa controllare prima di approvare il voiceover**:

1. **Audio tags ElevenLabs v3 rispettati?** Es. `[serious tone]`, `[contemplative]`, `[warm]`. ElevenLabs v3 non sempre li interpreta — ascoltare le transizioni di tono.
2. **Pause coerenti?** Pause troppo lunghe dopo i tag = dilatano il timing delle scene. Pause troppo corte = la prossima scena si sovrappone all'ultima frase precedente.
3. **Pronuncia di nomi propri e numeri?** Es. nomi propri del brand, "trenta secondi" (mai "30 secondi" che ElevenLabs dice come "tre zero"). Verificare ogni numero parlato è scritto come testo nel voiceoverText.
4. **Velocità (speed) coerente con il brand?** Es. una voce italiana B2B tipicamente richiede `speed` >= 1.10 (il valore validato per il brand è nel brief del progetto). Se ti sembra troppo veloce/lenta, iterare con voiceSettings diversi.
5. **Voce coerente con il tono dell'ad?** Se l'ad ha un beat triste e la voce suona positiva → cambiare voice ID o style.

**Iterazione voice** (rapida, ~$0.30 + 30s ciascuna):

Se la voce non va, modificare `voiceoverText` o `voiceSettings` nello script.json e rilanciare:
```bash
pnpm reel "path/to/script.json" --audio-only --from "<reel-dir>"
```

Il flag `--from` riusa la cartella, sovrascrive solo voiceover.mp3 + timestamps. NON tocca eventuali clip Kling già presenti (rilevante solo se stai iterando POST-Kling, ma in workflow standard al GATE 3 non ci sono ancora clip).

**GATE 3 — domanda esplicita all'utente**:

Dopo aver generato il voiceover, presentare il link cliccabile + chiedere via `AskUserQuestion`:
- ✅ Procedo con Kling (irreversibile, ~$7 e 30 min)
- 🔄 Itera voce con voiceSettings diversi (cheap, ~$0.30 ciascuna)
- ✏️ Modifica testo voiceover prima di rigenerare

NON procedere a FASE 5 senza approvazione esplicita.

---

## Test pre-produzione: Character Consistency

**Quando**: prima di lanciare la produzione di un reel **multi-character** dove l'identità riconoscibile di 2+ personaggi distinti è deal-breaker (es. parodia talk show 90s con 5-6 archetipi-tool, sketch dialogati, before/after con stesso protagonista in scene multiple).

**Perché**: la pipeline default (Gemini 3 Pro Image keyframe → Kling 3.0 Pro i2v) NON garantisce identity preservation su prompt action+emotion estremi (yelling, finger pointing, eyes popping). Drift facciale = reel non pubblicabile. Meglio scoprirlo in un test da $10 prima di bruciare $50-70 in produzione che si rivela inutile.

**Comando**:
```bash
pnpm test:consistency scripts/cast-talkshow-1990s.json
# quick mode (1 char, 2 var, ~$1.20):
pnpm test:consistency scripts/<cast>.json --chars=email-marketing --variations=2
# solo asset, no audit Gemini (utile se vuoi giudicare a occhio):
pnpm test:consistency scripts/<cast>.json --skip-vision
```

**Flow**: per ogni character del `cast.json`
1. Gemini 3 Pro Image → keyframe canonical close-up
2. Kling 3.0 Pro i2v dallo stesso keyframe → N video con action+emotion diverse
3. ffmpeg → estrai mid + last frame di ogni clip
4. Gemini Vision (system instruction dedicato) → 4 score per ogni frame estratto: `facialIdentity`, `hairStyle`, `outfit`, `overall` (1-10)
5. Aggregazione per character → verdict `viable` / `risky` / `not-viable`

**Output**:
- `<outDir>/cast.json` — copia input
- `<outDir>/<char-id>/{keyframe.png, var-N.mp4, var-N-mid.png, var-N-last.png, scores.json}`
- `<outDir>/report.md` — sommario aggregato con tabella verdict
- `<outDir>/report.html` — gallery navigabile keyframe vs frame estratti + score colorati

**Costo full (6 char × 3 var)**: ~$10.56 (keyframe $0.48 + Kling 18× $9 + vision 36× $1.08). Quick (1 char × 2 var): ~$1.20.

**Verdict globale**:
- `viable` — ≥80% characters con avg overall ≥7.5 e drift rate ≤15% → procedi alla produzione
- `risky` — qualche borderline ma nessun drift bloccante → riformula i character problematici o accetta margine di errore
- `not-viable` — almeno un character con drift rate >40% o overall <5 → il concept multi-character NON è sostenibile con questa pipeline; ripensare l'approccio (single character, archetipi più astratti, o cambio modello video)

**Esempio**: il cast `scripts/cast-talkshow-1990s.json` è modellato sul reel GoHighLevel del 2026-05-28 (5 archetipi-tool + protagonista + conduttrice). È il caso d'uso più stressante perché richiede caratterizzazioni caricaturali estreme con identità riconoscibile.

---

## FASE 5 — Kling + Render (irreversibile)

**Quando**: SOLO dopo GATE 3 approvato (voice approval).

**Comando**:
```bash
pnpm reel "path/to/script.json" --video-only --from "<reel-dir>" [--vision]
```

Riusa il voiceover + word-timestamps già generati, esegue solo Kling Stage 2 + Remotion render. Stage 1.5 (auto-sync `durationSec`) viene comunque rieseguito per sicurezza — è idempotente.

Costi: ~$7 per Kling (14 clip a ~$0.50 ciascuno), ~$0.30-0.80 opzionale se `--vision` per audit Gemini L2.
Tempo: ~30 min totali (20-25 min Kling paralleli, 3-5 min Remotion render).

**Se Stage 2 fallisce a metà** (rate limit, filtro contenuti su una scena): i clip riusciti restano su disco e la CLI stampa il comando di resume esatto (`--skip-existing-videos` rigenera solo i buchi, senza ripagare i clip già fatti). Gli errori transitori di fal (429/5xx/rete) vengono già ritentati in automatico con backoff prima di arrendersi.

Output finale: `final.mp4` + `scene-map.md` automatica.

---

## FASE 6 — Review

**Quando**: DOPO che la pipeline ha prodotto `final.mp4`. Mai saltare per i reel che vanno consegnati al cliente.

**Cosa fa la pipeline automaticamente**: in coda a `pnpm reel <script>` viene generato `scene-map.md` nella cartella del reel (`<reel-dir>/scene-map.md`). Questo è il **livello L1** della review: zero costo, ~2 secondi, gira sempre.

### L1 — Scene map "dati" (automatica)

Sorgenti: `script.json` + `composition-props.json` + `ffprobe` sui clip + sul voiceover. Output `scene-map.md` contiene:

- **Sintesi**: numero scene per tipo (KLING/VEO3/HEY/TEXT/KIN), durata totale vs audio, voce, contiene continuity / lipsync / omnihuman
- **Gate violati**: lista esplicita di problemi bloccanti, in particolare:
  - `FREEZE`: scene dove il clip Kling è più corto del segmento audio → Remotion congela l'ultimo frame. Non pubblicabile (vedi REGOLA D'ORO sync video↔audio in FASE 2).
  - File `.mp4` mancanti
- **Tabella scene**: numero, time start, durata, tipo, flags, sync status, voiceover segment, visual prompt troncato

**Processo di review L1** (manuale, dopo che la pipeline è finita):
1. Apri `scene-map.md`
2. Se ci sono FREEZE → rigenera il clip Kling più lungo (Stage 2 della pipeline con `durationSec` aumentato), oppure splitta la scena in 2 < 10s
3. Se ci sono file mancanti → riesegui solo le scene fallite con `--skip-existing-videos`
4. Riferisciti alle scene per **numero** (#21, #23, etc.), MAI per tempo — il numero è stabile, i tempi cambiano a ogni rigenerazione

### Freeze INTERNO al clip (non flaggato da L1)

Oltre al freeze Remotion (clip < scena, flaggato da scene-map) esiste il **freeze interno al clip Kling**: il clip è abbastanza lungo MA il personaggio fa l'azione e poi **si ferma** per il resto della durata. Tipico su: continuity-clip (azione + hold), card con gesti discreti, clip riusati. Si percepisce come blocco a metà reel.

- **Localizzare** (non a occhio): `ffmpeg -i final.mp4 -vf "freezedetect=n=-55dB:d=0.4" -map 0:v -f null -` → stampa `freeze_start/duration/end`; mappa i timestamp alle scene via composition-props.
- **Mascherare SENZA rigenerare**: Ken Burns push-in lentissimo e continuo sul clip incriminato:
  ```bash
  ffmpeg -i in.mp4 -vf "scale=2160:3840,zoompan=z='min(1.0+0.00028*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,setsar=1" -an -c:v libx264 -pix_fmt yuv420p out.mp4
  ```
  La `z` deve crescere per TUTTA la durata mostrata (cap alto, non raggiunto prima della fine) sennò la coda si ri-blocca. Validato su un reel cliente 2026-06-09: 8 freeze → 0.
- **Musica differenziata per personaggio** (stessa ad): traccia composita che alterna 2 brani ai confini di scena con micro-fade + fade-out finale → `props.musicUrl` (BasicReel la mixa al 15% sotto la voce). Brani commerciali-OK gratis: Pixabay Music, Mixkit.

### L2 — Audit Gemini Vision (opzionale, a pagamento)

Quando L1 è pulito ma sospetti che i clip Kling non rispettino i `visualPrompt` (artefatti facciali, soggetto sbagliato, camera statica quando richiesto movimento, DOF profondo quando richiesto shallow, palette divergente, testo illegibile in scene dove non dovrebbe esserci), lancia:

```bash
pnpm scene-map "<reel-dir>" --vision
```

- **Modello**: `gemini-3.1-pro-preview` (override via env `GEMINI_VISION_MODEL`, es. `gemini-3.5-flash` per risparmiare 10× a parità di copertura ma giudizio meno severo)
- **Costo**: ~$0.30-0.80 per reel da 30 scene con Pro
- **Tempo**: 60-90 secondi (concorrenza 6 chiamate parallele)
- **Output aggiuntivo nel `scene-map.md`**: colonna Vision (✅ ok / 🟡 borderline / 🔴 rigenerare) + sezione "Dettaglio vision" con `observed` / `issues` / `verdict` per ogni scena non-OK
- **Cache**: `scene-N-vision.json` per scena nella `assets/`, invalidata SOLO se cambia il `visualPrompt`. Re-run senza modifiche = 0 chiamate API.

**REGOLA**: prima di lanciare `--vision` sempre confermare il costo con Michel. È denaro reale. NON è un default.

**Modi per lanciarlo**:
- `pnpm reel <script> --vision` → L1 + L2 in coda alla pipeline in un singolo comando
- `pnpm scene-map <reel-dir> --vision` → L2 standalone su un reel già renderizzato
- `pnpm scene-map <reel-dir> --vision-refresh` → forza re-interrogazione di tutte le scene ignorando la cache (a costo pieno)

**Edge case — rigenerazione singola scena**: se rigeneri un clip Kling senza modificare il `visualPrompt`, la cache `scene-N-vision.json` vale ancora ma sta giudicando il vecchio clip. Workaround: cancella a mano i `scene-N-vision.json` delle sole scene rigenerate prima di rilanciare `--vision` normale.

**Cosa Gemini sa giudicare bene** (validato su reel reali):
- Artefatti facciali (mani fuse, dita extra, bocche distorte, denti deformi)
- Soggetto sbagliato (5 personaggi invece di 4, oggetti diversi)
- Camera totalmente statica quando il prompt chiede dolly/pan/zoom
- DOF profondo quando il prompt chiede f/1.8 shallow
- Testo illegibile in scene dove il prompt diceva "no readable text"
- Palette HEX divergente

**Cosa Gemini fa meno bene**: giudizio puramente estetico ("è bello?"), micro-artefatti subliminali, valutazione "vale per il brand?". Per quelli serve sempre review umana.

---

## FASE R — Refresh Creativo (varianti di top ad esistenti)

Quando l'input NON è un copy/brief ma una **video-ad performante da clonare**, si usa il processo "refresh creativo": si trascrive e analizza l'originale shot per shot, si decide cosa ricreare con l'AI e cosa recuperare verbatim dall'originale, poi si passa per i gate normali. La skill `/refresh-creativo` (`framework/.agents/skills/refresh-creativo/`) è l'orchestratore; reel-engine fornisce i CLI mechanici.

**Sequenza (mai saltare un gate — lezione da un refresh reale del 2026-06-06 (voto 5/10), che aveva ereditato uno script.json sbagliato e generato senza ripassare dai gate):**

```
R1 pnpm refresh:deconstruct <orig.mp4> --out <project-dir>   → deconstruction.json + selection.md   (auto)
R2 🟡 tabella scene: l'utente approva/ribalta i verdetti (ai-recreate/static-png/card/splice)
     NB dal 2026-06-11: una scena con TESTO leggibile (schermo, etichetta, foglio, insegna) non forza
     più static-png/splice — è candidabile ad ai-recreate via recipe TEXT-IN-SCENE (keyframe col testo
     esatto o --ref=screenshot). Splice resta la mossa per talking-head e animazioni esplicative.
R3 🟡 treatment (FASE 1, pre-riempito)
R4 script.json (mapping verdetto→scena; sourceClip per gli splice; videoMotionPrompt pulito per gli ai-recreate)
R5 🟡 pnpm reel <script> --audio-only           → voce (GATE 3)
R6 🟡 pnpm storyboard <script> --from <reel-dir> → keyframes.html (GATE 4) — controlla UI/testo/loghi fantasma nei keyframe
R7 pnpm reel <script> --video-only --from <reel-dir> --skip-existing-videos   → i2v ancorato (motore patchato)
R8 🛡️ pnpm refresh:verify <reel-dir>            → subject-match keyframe↔clip, hard-block
R9 pnpm render <reel-dir> + pnpm scene-map <reel-dir>   → review per-scena
```

**Verdetti → rappresentazione scena**: `ai-recreate` → keyframe + `videoMotionPrompt` (i2v); `static-png` → `imageUrl` + `kenBurnsRange`; `card` → `dashboardComponent`; `splice` → `sourceClip { file, startSec, endSec }` (estrae dall'originale, re-encode 1080×1920/-an, `hideSubtitle` auto).

**Prerequisito**: la patch keyframe-i2v in `src/pipeline.ts` (`generateScenesParallel` deve fare image-to-video col keyframe, non text-to-video). Senza, il GATE 4 è finto. CLI nuovi: `pnpm refresh:deconstruct`, `pnpm refresh:verify`. Lezioni in `framework/.agents/skills/refresh-creativo/memory/patterns.md`.

## Formato video

- **Reel verticale**: 1080×1920, 30fps
- **Durata tipica**: 15-60 secondi
- **Output**: `~/Movies/reel-ai/YYYY-MM-DD/reel-NNNN/final.mp4` (base configurabile con `REEL_OUTPUT_BASE` nel `.env`; il simlink `output-movies/` nella root è solo un alias comodo per-macchina)

## Composizioni disponibili

### BasicReel
Props: `{ hook, scenes: { text, imageUrl, duration }[], cta, voiceoverUrl, musicUrl? }`
Formato: hook animato → scene con background + testo overlay → CTA

### TalkingHeadReel
Props: `{ videoUrl, subtitles: { text, startFrame, endFrame }[], musicUrl? }`
Formato: talking head a schermo pieno + sottotitoli animati

### ProductShowcase
Props: `{ title, products: { imageUrl, name, price?, features? }[], voiceoverUrl, musicUrl? }`
Formato: carousel prodotti con zoom/pan + testo overlay

### TextOverlayReel
Props: `{ backgroundVideoUrl, textBlocks: { text, startFrame, endFrame, style? }[], musicUrl? }`
Formato: video background + testo kinetico grande (formato "motivational")

## Componenti

| Componente | Props chiave | Uso |
|-----------|-------------|-----|
| AnimatedText | text, animation, fontSize, color | Testo con spring/fade/slide |
| Subtitle | words[], currentFrame | Sottotitoli word-by-word |
| BackgroundVideo | src | OffthreadVideo wrapper |
| BackgroundImage | src, kenBurns? | Immagine con effetto zoom lento |
| LogoWatermark | src, position | Logo in angolo |
| TransitionWipe | type, progress | Transizioni tra scene |

## Servizi AI

### fal.ai (src/services/fal.ts) — DEFAULT per i video (kling-legacy)
- Video da immagine: `fal-ai/kling-video/v3/pro/image-to-video` (path principale: i2v dal keyframe approvato)
- Video da testo: `fal-ai/kling-video/v3/pro/text-to-video`
- Immagini: `fal-ai/flux-pro/v1.1`
- Lip-sync: `fal-ai/sync-lipsync` · OmniHuman v1.5: `fal-ai/bytedance/omnihuman/v1.5`
  - **OmniHuman = unico lip-sync sui NON-UMANI** (pergamena, animali, oggetti). NON usare `fal-ai/kling-video/lipsync/audio-to-video` per i non-umani: il suo **face-detector rifiuta** il volto stilizzato/non-umano (errore `face_detection_error`, non-deterministico → fino a 24 fallimenti consecutivi su clip diversi, validato 2026-06-15 su un reel cliente). Kling lip-sync resta valido SOLO per volti umani reali/3D/2D.
  - **Prompt anti-arti OmniHuman (default, dal 2026-06-15)**: OmniHuman, animando un "corpo" non-standard, fa crescere **braccia/mani allucinate**. Fix cablato: la pipeline passa di default `OMNIHUMAN_NO_LIMBS_PROMPT` (in `src/services/fal.ts`) alla chiamata OmniHuman → elimina gli arti (validato su un reel cliente (pergamena clay, 4/10 → 10/10)). Override per-scena con il campo `omnihumanPrompt` nello script.json (stringa custom, oppure `""` per disabilitare su un soggetto UMANO). OmniHuman v1.5 segue il prompt (la v1.0 no). NB: questo rende NON più necessario rifare i keyframe "senza braccia" — il prompt sopprime gli arti anche su keyframe che ne hanno.
- Veo via fal (alternativa): `fal-ai/veo3/fast` (override `VEO_MODEL`) + `fal-ai/veo3.1/image-to-video` (override `VEO_I2V_MODEL`)
- Sempre `fal.subscribe()` (gestisce la coda); dal 2026-06-10 tutte le chiamate hanno retry con backoff sugli errori transitori (429/5xx/rete) — mai su 403 saldo esaurito o 422 moderazione
- Triggered da `videoEngine: "kling-legacy"` o `provider: "kling"` — è il DEFAULT quando non specificato.

### Higgsfield (src/services/higgsfield.ts) — ⚠️ DEPRECATO 2026-05-28
- Disabilitato per costi irragionevoli (~$25-30/reel vs ~$5-7 con fal.ai Kling) e qualità inferiore validata su reel reali.
- Il codice resta SOLO per backward compat con reel storici (`videoEngine: "seedance"` / `"kling-hf"`). NON usare per reel nuovi; `pnpm higgsfield:auth` non serve a nessun workflow attuale.

### Google AI (src/services/gemini-image.ts + gemini-vision.ts) — Storyboard + Audit
- **gemini-3-pro-image-preview** (image-gen): default per Stage 1.7 Storyboard. Vince mini-pilot 6-way del 2026-05-27 (9.5/10 vs Imagen 4 Ultra 7/10, Nano Banana Pro 8.5/10, Seedream 6/10, Flux 2 Pro 8.5/10, Gemini Flash 7/10) per photoreal italiano B2B. Costo ~$0.06-0.10 per immagine.
- **gemini-3.1-flash-image-preview** (fallback): override via env `GEMINI_IMAGE_MODEL` per batch economico (~$0.04/img). Sconsigliato per output finale.
- **gemini-3.1-pro-preview** (vision audit): scene-map L2 con `--vision`. Override via env `GEMINI_VISION_MODEL`.
- Reference Pinterest auto-estratto da `keyframeReferenceUrl` se è un pin URL (vedi `src/services/pinterest-reference.ts`).

### ElevenLabs (src/services/elevenlabs.ts)
- TTS con word-level timestamps per subtitle sync
- Voice ID configurabile in .env
- **Lead sottotitoli 100ms**: i `startSec` dei word-timestamps ElevenLabs sono ~100ms in ritardo sull'onset acustico (marcano la fine del fonema iniziale). `buildSubtitleWords()` in [src/utils/composition-props.ts](src/utils/composition-props.ts) applica `leadSec = 0.1` di default (validato 2026-05-28, "ora è ottimo"). Se emerge sfalso: in ritardo → 0.13-0.15, in anticipo → 0.06-0.08; iterare è cheap (recalc + render, no Kling)
- **Post-fix voce v3 senza rigenerare** (due leve, entrambe a $0 crediti — lavorano sul backup `voiceover-raw.mp3` che `accel-voiceover.py` tiene al primo run; poi sempre `--sync-only`):
  - **Velocità**: `voiceSettings.speed` su `eleven_v3` è inaffidabile → genera a velocità normale, poi `python3 scripts/accel-voiceover.py <reelDir> <atempo>` (atempo, preserva il pitch, riscala i word-timestamps, anti-compounding).
  - **Pitch (voce troppo acuta/grave)**: atempo NON tocca il pitch. Dal 2026-06-15 `accel-voiceover.py` accetta un 3° arg semitoni: `python3 scripts/accel-voiceover.py <reelDir> <atempo> <pitch_semitoni>` (es. `1.25 -1` = un semitono giù + 1.25x). Internamente `asetrate+atempo`: la durata resta `<atempo>`, i timestamp si riscalano solo su quello. Iterazione tipica: prepara 2-3 candidati a mano (`asetrate=SR*2^(st/12),aresample=SR,atempo=<atempo>/2^(st/12)`) come `voiceover-cand*.mp3`, fai scegliere a Michel, poi applica col 3° arg. (Validato un cliente Variante B 2026-06-15: take j22 uscito troppo acuto+veloce → −1 st · 1.25x.)
- **eleven_v3 cold-start a inizio traccia → apertura "warmed" + splice** (validato su un reel cliente Variante B 2026-06-15): la prosodia di v3 è instabile sulla **prima frase** (poco contesto, il modello si "assesta" dopo qualche secondo) e un audio tag a carattere 0 (es. `[serious]`) front-carica la sua intensità sull'apertura che poi si allenta → l'inizio "cambia ritmo e tono" rispetto alla metà. **NON è il post-processing** (pitch/atempo sono uniformi sulla traccia, non possono peggiorare solo l'inizio): il difetto è nella generazione. Fix che **preserva la metà già approvata**:
  1. Genera una **traccia-apertura separata** = una frase-civetta (primer) sotto lo stesso tag + il testo delle prime scene, stessi `voiceId`/`voiceSettings`/`voiceModelId` (temp script.json → `pnpm reel <tmp> --audio-only --skip-enhance`). Il primer "scalda" il modello: quando arriva la riga 1 reale, la voce è già assestata come la metà.
  2. **Splice** sui word-timestamps: taglia il primer (da `startSec` della prima parola reale) e incolla l'apertura warmed sul raw esistente a una **pausa netta** (cut a fine-parola + gap naturale, es. dopo una frase a punto fermo). Ricostruisci `word-timestamps-raw.json` mergiando (warmed offset `-cut0`) + (raw-tail offset per il delta) e premetti un token tag `[...]` a 0. Backup dei raw prima di sovrascrivere.
  3. Poi applica pitch/velocità (sopra) sul raw splicato e `--sync-only`. Seam in silenzio = inudibile; rischio = lieve salto di timbro tra due take v3 (mitigato dal cut in pausa). Alternativa più sicura sulla metà ma con rigenerazione completa: primer davanti a TUTTO il testo, poi trim del solo primer.

> Lo script.json non viene generato da un servizio: lo scrive Claude in conversazione (FASE 3), validato dallo Zod schema in [src/schemas/script.ts](src/schemas/script.ts).

## Convenzioni

- Ogni reel output è una cartella autocontenuta sotto `OUTPUT_BASE` (default `~/Movies/reel-ai/`, override `REEL_OUTPUT_BASE`)
- I props delle composizioni sono validati con Zod
- Gli asset generati vanno in `<reel-dir>/assets/`
- `composition-props.json` porta lo `scriptHash` dello script: `pnpm render` rileva da solo gli edit manuali a script.json e ricalcola i props (niente più `pnpm recalc-props` da ricordare — resta disponibile come comando esplicito). **Legacy**: reel renderizzati prima del 2026-06-10 non hanno `scriptHash` (il render stampa un avviso, NON blocca) → lanciare una volta `pnpm recalc-props <reelDir> [script.json]` e da lì vale l'automatismo. Per propagare un `imageUrl` nuovo (es. PNG dashboard) servono entrambi gli argomenti `<reel-dir> <script.json>`
- Mai pubblicazione automatica — solo rendering locale; nessun auto-open (la CLI stampa il comando `open` pronto; opt-in con `--auto-open`)

<!-- vc-dist 1.1.2 ref:5QCC -->
