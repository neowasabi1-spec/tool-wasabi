# Reel Engine

> **Produzione (Claude Cloud host):** [`ENGINE-HOST.md`](ENGINE-HOST.md) · **Mediabuyer UI:** [`MEDIABUYER-SETUP.md`](MEDIABUYER-SETUP.md) (MCP, chiavi, publish in Created videos). Comando: `../scripts/setup-reel-mediabuyer.sh`.

Pipeline di produzione reel 9:16 con AI: voiceover ElevenLabs → keyframe Gemini → video Kling (fal.ai) → compositing Remotion. Orchestrata da Claude Code attraverso 4 gate di approvazione umana (treatment → mapping → voce → keyframe) prima dello step irreversibile.

> **Il modo consigliato di usare il motore è dentro Claude Code**, aprendo questa cartella come workspace: l'agente legge [CLAUDE.md](CLAUDE.md) (il manuale operativo completo del workflow) e ti guida fase per fase. Questo README copre il setup della macchina e i comandi essenziali.

## Prerequisiti

| Cosa | Versione | Installazione macOS |
|---|---|---|
| Node.js | ≥ 20 | `brew install node` |
| pnpm | 10.x | `corepack enable` (incluso in Node) oppure `brew install pnpm` |
| ffmpeg + ffprobe | qualsiasi recente | `brew install ffmpeg` |
| whisper *(solo per `/refresh-creativo`)* | openai-whisper | `pip install openai-whisper` |

Su **Windows**: la via consigliata è il **nativo** (Node + ffmpeg via `winget`; come shell serve solo Git for Windows). Vedi [docs/PORTING-WINDOWS.md](docs/PORTING-WINDOWS.md) — il tuo Claude Code può fare gli adattamenti da solo seguendo quel documento. WSL2 resta come fallback se il nativo si blocca.

## Setup (una volta sola)

```bash
cd reel-engine
pnpm install
cp .env.example .env
```

Poi apri `.env` e inserisci le **tue** chiavi API (ognuno usa le proprie):

| Chiave | Dove ottenerla | Serve per |
|---|---|---|
| `FAL_KEY` | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) | video Kling (~$0.50/clip 5s) |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) | voiceover (~$0.30/reel) |
| `GOOGLE_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | keyframe storyboard + audit vision |

Verifica del setup (gratis, nessuna API call):

```bash
pnpm exec tsc --noEmit   # il progetto compila
ffmpeg -version          # ffmpeg c'è
```

## Dove finiscono i reel

Default: `~/Movies/reel-ai/YYYY-MM-DD/reel-NNNN/` (override con `REEL_OUTPUT_BASE` nel `.env`). Ogni reel è una cartella autocontenuta: `script.json`, `assets/` (voiceover, clip, keyframes), `composition-props.json`, `final.mp4`, `scene-map.md`.

## Il workflow in breve (4 gate)

I dettagli completi sono in [CLAUDE.md](CLAUDE.md) — Claude Code li segue da solo. La sequenza:

```bash
# 1. GATE 1+2 (in conversazione con Claude): treatment.md + mapping scene↔voce, poi script.json

# 2. Voce (~$0.30, 30s) → GATE 3: ascolti e approvi
pnpm reel path/to/script.json --audio-only

# 3. Keyframe Gemini (~$0.06-0.10/scena) → GATE 4: approvi ogni frame
pnpm storyboard path/to/script.json --from "<reel-dir>"
#    apri <reel-dir>/keyframes.html, poi per ogni scena ok:
touch "<reel-dir>/assets/keyframes/scene-N.png.approved"

# 4. Video + render (IRREVERSIBILE, ~$5-7 per reel 2 min)
pnpm reel path/to/script.json --video-only --from "<reel-dir>"

# 5. Review automatica L1 (gratis)
pnpm scene-map "<reel-dir>"
```

**Regola d'oro economica**: prima del GATE 4 ogni errore costa centesimi; dopo, ogni scena sbagliata costa ~$0.50-2 e minuti di attesa. Itera a sinistra dei gate.

## Comandi CLI

| Comando | Cosa fa |
|---|---|
| `pnpm reel <script> --audio-only` | Solo voiceover (iterazione economica) |
| `pnpm reel <script> --video-only --from <dir>` | Solo video, riusa l'audio approvato |
| `pnpm reel <script> --sync-only --from <dir>` | Ricalcola sync VO↔scene, zero API |
| `pnpm reel <script> ... --skip-existing-videos` | **Resume**: rigenera solo le scene senza clip (dopo un errore) |
| `pnpm storyboard <script> --from <dir>` | Keyframe Gemini + gallery `keyframes.html` (GATE 4) |
| `pnpm render <reel-dir>` | Solo render Remotion (dopo modifiche manuali: prima `pnpm recalc-props`) |
| `pnpm scene-map <reel-dir> [--vision]` | Review L1 gratis; `--vision` = audit Gemini a pagamento (~$0.30-0.80) |
| `pnpm studio` | Remotion Studio (anteprima composizioni nel browser) |
| `pnpm refresh:deconstruct <ad.mp4> --out <dir>` | Analizza una top ad da clonare (workflow `/refresh-creativo`) |
| `pnpm reel <script> ... --auto-open` | Apre voiceover/final in QuickTime a fine run (default: stampa il comando `open`) |

`pnpm reel --help` mostra tutti i flag con le note d'uso.

## Troubleshooting

| Sintomo | Causa e fix |
|---|---|
| `Prerequisiti mancanti: ffmpeg` | Installa ffmpeg (`brew install ffmpeg`), riapri il terminale |
| `403 Forbidden` da fal.ai | Saldo esaurito sul TUO account fal: ricarica, poi riprendi con `--skip-existing-videos` (i clip già generati non si ripagano) |
| `ELEVENLABS_API_KEY not set` | `.env` mancante o vuoto nella root di reel-engine |
| `GATE 4: N keyframe non approvati` | Comportamento voluto: apri `keyframes.html` e crea i marker `.approved` |
| Il render non riflette le modifiche allo script.json | Solo per reel renderizzati prima del 2026-06-10 (il log avvisa "senza scriptHash"): lancia una volta `pnpm recalc-props <reel-dir>`. Per i reel nuovi il render si accorge da solo degli edit e ricalcola |
| Scena congelata (freeze) nel final.mp4 | Clip più corto del segmento audio: vedi `scene-map.md` (righe FREEZE) e la sezione "REGOLA D'ORO" in CLAUDE.md |
| Warning `scene con audio > 10s` | Kling genera max 10s/clip: spezza la scena in 2 nello script.json PRIMA di generare i video |

## Struttura del progetto

```
reel-engine/
├── CLAUDE.md            ← manuale operativo completo (workflow, gate, regole)
├── src/pipeline.ts      ← orchestratore 3 stadi (voce → video → render)
├── src/services/        ← ElevenLabs, fal.ai, Gemini, Veo, HeyGen
├── scripts/             ← CLI (generate-reel, storyboard, scene-map, render-only…)
│   ├── projects/        ← script.json storici dei reel prodotti (per cliente)
│   └── archive/         ← esperimenti one-off conclusi (non lanciare)
├── remotion/            ← composizioni e componenti React per il compositing
├── public/fonts/        ← font committati (GT Super)
└── docs/                ← guide aggiuntive (porting Windows, audit)
```

<!-- vc-dist 1.1.2 ref:5QCC -->
