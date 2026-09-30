---
name: footage-montage
description: >
  Trasforma un TUO video parlato già girato (talking-head, selfie col telefono,
  consulenza/pitch registrato) in un reel 9:16 MONTATO come farebbe un editor:
  taglio hook-first + sottotitoli kinetic sulla TUA voce reale, e — se vuoi il
  montaggio completo — b-roll generati con l'AI sui punti chiave, card animate,
  punch-in dinamici, color grade. La tua faccia e la tua voce restano reali; il
  motore aggiunge tutto il resto. Attivare quando l'utente dice "monta questo mio
  video", "arricchisci il mio footage", "ci metti i sottotitoli e dei b-roll",
  "fammi un reel da questo video che ho girato". NON è per generare un reel da un
  copy da zero (quello è /reel-director, con voce ElevenLabs e scene generate).
---

# Footage Montage — monta un tuo video parlato

Add-on del Reel Engine. Parti da un **footage reale** (tu che parli) e lo trasformi in
un reel montato, **tenendo la tua faccia e la tua voce vere**. Due livelli:

- **Baseline** — taglio hook-first + **sottotitoli kinetic** sulla tua voce. Veloce.
- **Completo** — in più: **b-roll** generati (Kling) sui sostantivi concreti, **card
  animate** (es. la chat dell'AI che scrive copy), **punch-in** sulla faccia, **grade**.

## Come funziona (il "trucco")

La tua **voce originale** viene estratta come **unica traccia globale** (`voiceoverUrl`):
BasicReel **muta automaticamente tutti i clip**. Così alterni liberamente:
**A-roll** (pezzi del tuo video reale) · **b-roll** (clip generati) · **card** · **endcard**
mentre la voce vera scorre continua sotto e i sottotitoli kinetic restano sincronizzati.

**Sync automatico**: nello strumento `build-montage.py` le scene si elencano in ordine e
ogni A-roll viene ripreso dal video **all'istante esatto in cui la voce è arrivata** →
il labiale non si sfasa mai, nemmeno dopo un b-roll. Tu specifichi solo le durate.

## Prerequisiti
- Reel Engine installato (`/reel-setup` fatto) + `ffmpeg`.
- Per i **b-roll** servono le chiavi `GOOGLE_API_KEY` (keyframe Gemini) e `FAL_KEY` (Kling).
- Per la **trascrizione automatica** serve un Mac Apple Silicon (`bash scripts/footage-to-reel/setup.sh`,
  una volta per macchina). Su altri sistemi o se hai già lo script, vedi lo step 1 (3 vie).

## Workflow (con i GATE — non saltarli)

### 1. Procurati i TEMPI DELLE PAROLE (word-timestamps)
I sottotitoli kinetic si agganciano al **tempo di ogni parola**, non al solo testo. Tre vie —
in tutti i casi l'obiettivo è ottenere `assets/transcript.json` nel formato whisper
(`segments[].words[].{word,start,end}`):

- **(a) Automatica — Mac Apple Silicon** (default, gratis, offline):
  ```bash
  bash scripts/footage-to-reel/transcribe.sh "/percorso/del/tuo-video.mov" assets
  ```
  → `assets/<base>.json`. Rinominalo/copialo come `assets/transcript.json`.
- **(b) Da un servizio — qualunque OS / niente Mac**: carica il video (o solo l'audio) su un
  servizio di trascrizione che dà i **timestamp**, es. **TurboScribe**, Whisper API, Descript.
  Esporta con i tempi (SRT/VTT/JSON word-level) e **passa il file a Claude**: convertilo nel
  formato sopra (se l'export è per-frase e non per-parola, distribuisci le parole nell'intervallo
  della frase in modo proporzionale alla lunghezza).
- **(c) Hai già lo SCRIPT del video** (il testo del parlato): daglielo. Serve **comunque sempre**
  per **correggere** i nomi/termini che la trascrizione sbaglia (oggi: "CopyCloud"→CopyClaude) →
  usalo per impostare `fixes`/`mergeFixes`. Se lo script è la TUA UNICA fonte e non puoi
  trascrivere, allinealo all'audio per i tempi (whisper sul tuo sistema, o un servizio del punto b);
  da solo, senza tempi, non basta per i sottotitoli parola-per-parola.

Crea una cartella di progetto, copia lì il video in `assets/` e il transcript come
`assets/transcript.json`.

### 2. Leggi il transcript e proponi il TAGLIO + il MAPPING — 🟡 GATE
Leggi il testo. Trova l'**hook** (claim forte / numero / provocazione) e fai partire il taglio
DA LÌ, non dal lead-in. Poi proponi all'utente una **tabella di montaggio**: per ogni pezzo
del discorso, A-roll (la sua faccia) oppure b-roll/card (e cosa mostrano). Regole:
- **A-roll predominante** (~50-60%): i momenti di recitazione, onestà, sguardo in camera
  restano sempre sulla faccia.
- **B-roll solo sui sostantivi concreti** (una cosa che si può filmare). Mai su concetti
  astratti → per quelli usa `kineticTypo` (tipografia).
- **Card** per i momenti "schermo/AI/prodotto" (es. `copy-chat-card`).
- Se l'utente nomina un refuso o un nome che whisper ha sbagliato, segnalo: si corregge nei
  sottotitoli (`fixes` / `mergeFixes`).
L'utente approva o aggiusta. **Solo dopo** vai avanti.

### 3. (solo Completo) Genera i KEYFRAME dei b-roll — 🟡 GATE
Per ogni b-roll, un keyframe fotoreale:
```bash
npx tsx scripts/gen-variant.ts "<descrizione immagine, fotoreale, 9:16, luce diurna, DOF shallow>" "keyframes/kfN.png"
```
**Guarda ogni keyframe** (è qui che gli errori costano 0). Occhio alla UI fantasma della
camera-app iPhone: se compare, rigenera aggiungendo *"candid cinematic film still, NOT a phone
screenshot, no camera app UI, no status bar, clean frame edges"*. Fai approvare i keyframe.

### 4. (solo Completo) Genera i b-roll (Kling i2v)
Scrivi `broll-jobs.json` (keyframe → prompt di movimento MINIMO → out → duration 10) e:
```bash
npx tsx scripts/footage-montage/gen-broll.ts broll-jobs.json
```
Prompt di movimento: *"Very slow dolly-in. ... Camera almost still, cinematic, shallow depth
of field."* Mai descrivere il contenuto dello schermo/testo (lo corromperebbe).

### 5. Assembla il montaggio
Scrivi la `edit-list.json` (vedi esempio sotto) e:
```bash
python3 scripts/footage-montage/build-montage.py edit-list.json
```
Estrae voce + A-roll (sync-safe), genera i sottotitoli, costruisce `composition-props.json`.
**Leggi i ⚠️ warning**: se un b-roll è più corto della sua scena (freeze) o se la copertura
non torna, aggiusta le durate.

### 6. Render + review
```bash
pnpm render "<cartella-progetto>"
```
→ `final.mp4`. Estrai qualche frame con ffmpeg ai punti chiave (hook, una card, una giunzione
A-roll/b-roll, l'endcard) e verifica: sottotitoli leggibili e sincronizzati, niente freeze,
card on-brand. Consegna con `open "<...>/final.mp4"`.

## Esempio edit-list.json
```jsonc
{
  "source": "assets/tuo-video.mov",
  "transcript": "assets/transcript.json",
  "outDir": ".",
  "clipStart": 4.90, "clipEnd": 89.70, "fps": 30,
  "subtitleStyle": { "kinetic": true, "variant": "motion", "captionFont": "anton" },
  "masterGrade": { "saturation": 1.06, "contrast": 1.03, "temperature": 6 },
  "fixes": [{ "t": 25.54, "text": "CopyClaude" }],
  "mergeFixes": [{ "from": ["video", "blog"], "to": "VideoClaude" }],
  "scenes": [
    { "type": "aroll", "durSec": 8.22, "punchIn": 1.10 },
    { "type": "broll", "clip": "assets/broll-2.mp4", "durSec": 5.28 },
    { "type": "card",  "component": "copy-chat-card", "durSec": 4.72 },
    { "type": "aroll", "durSec": 9.06, "punchIn": 1.08 },
    { "type": "kineticTypo", "words": [{"t":"NON"},{"t":"RESTARE"},{"t":"FUORI","accent":true}],
      "durSec": 3.0, "bg": "#1F1E1D", "accent": "#D97757", "textColor": "#F2F1EC" },
    { "type": "endcard", "image": "assets/endcard.png", "durSec": 2.5 }
  ]
}
```

## Regole d'oro
- **Hook-first**: il taglio PARTE sulla frase-gancio (validato: +2 punti di voto).
- **Durata b-roll ≤ durata clip generato** (genera Kling a 10s, usa scene ≤9s) → niente freeze.
- **A-roll ≤ ~14s** l'uno: se un beat è più lungo, spezzalo con un b-roll/card in mezzo.
- **B-roll = solo cose concrete**; astratto → `kineticTypo`.
- **Card = Remotion** (`copy-chat-card` o un tuo componente), MAI far disegnare schermi/testo a Kling.
- **Niente musica** di default su un talking-head da community (la voce regge da sola); se la
  vuoi, `"musicUrl": "assets/music.mp3"` in `props` (BasicReel la mixa al 15%).
- La card `copy-chat-card` ha testo/brand nel file `remotion/components/dashboards/CopyChatCard.tsx`:
  modifica il blocco CONFIG per il tuo brand; per più varianti, duplica il file + nuovo id nel registry.

## Cosa NON fare
- Non usare questo per un reel da copy senza footage (→ `/reel-director`).
- Non clonare la voce / usare un digital twin per il parlato: qui la voce è quella vera.
- Non far generare a Kling schermi con testo/dashboard (gibberish): usa card Remotion o keyframe TEXT-IN-SCENE.
