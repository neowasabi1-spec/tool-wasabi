---
name: reel-setup
description: Installa e configura il Reel Engine sulla macchina del collaboratore, da zero a primo test funzionante. Attivare quando l'utente vuole installare il reel engine, configurare il motore reel, fare il setup iniziale, o quando reel-director rileva che il motore non è installato. Copre macOS e Windows (nativo; WSL2 solo come fallback), gestisce il PATH dell'ambiente in cui Claude lancia i comandi (scheda Code / app GUI, installa Homebrew se manca), chiavi API per-persona, verifica finale.
---

# Reel Setup — installazione guidata del motore

Porta l'utente da zero a un Reel Engine funzionante e verificato. Procedi passo-passo, UN blocco alla volta, verificando l'esito di ogni passo prima del successivo. Non dare per scontato nulla sulla macchina.

> ⚠️ **Dove giri conta.** Se sei nella scheda **Code** di Claude Desktop (o in qualsiasi app GUI), i comandi partono in un ambiente con **PATH minimo**: NON eredita il PATH del Terminale (non legge `~/.zshrc`/`~/.zprofile`). Quindi i tool installati "a mano" prima possono risultare `command not found` qui, e i tool che installi ORA potrebbero non essere raggiungibili finché non sistemi il PATH **di questa sessione**. Regola: rileva l'ambiente PRIMA di installare, verifica la raggiungibilità con `command -v` DOPO, e se un tool appena installato non risponde → è il PATH (Step 1, blocco 3).

## Step 0 — Riconosci piattaforma e ambiente

Prima di toccare qualsiasi cosa, fotografa la macchina:

```bash
uname -s                              # Darwin = macOS · Linux = Linux/WSL2
uname -m                              # arm64 = Apple Silicon · x86_64 = Intel
echo "PATH=$PATH"
command -v brew node pnpm ffmpeg 2>/dev/null   # cosa è GIÀ raggiungibile QUI
```

- **Darwin** → macOS, vai allo Step 1 (macOS).
- **Linux** (incluso WSL2) → Step 1 (Linux/WSL2).
- **Windows nativo** → procedi in NATIVO: è il percorso usato all'evento. Node + ffmpeg via `winget` (Step 1), shell = Git for Windows. Segui `docs/PORTING-WINDOWS.md` (Opzione B, contiene anche gli adattamenti POSIX per te, l'agente). **WSL2 NON è necessario**: proponilo solo come fallback se il nativo si blocca davvero.

Annota quali tool `command -v` già risolve: **non reinstallare ciò che c'è già ed è raggiungibile**.

## Step 1 — Prerequisiti di sistema (PATH-safe)

### macOS

Homebrew è la via affidabile. Su Apple Silicon vive in `/opt/homebrew`, su Intel in `/usr/local`.

**Blocco 1 — Homebrew (installa solo se manca, poi mettilo nel PATH di QUESTA sessione):**

```bash
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# porta brew nel PATH di questa sessione (Apple Silicon o Intel)
if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew   ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
brew --version
```

> Su un Mac nuovo l'installer di Homebrew può chiedere gli **strumenti da riga di comando** (`xcode-select`): se compare la finestra "Installa", l'utente clicca **Installa** e aspetta qualche minuto, poi si riprende. Se serve forzarla: `xcode-select --install`.

**Blocco 2 — Node + ffmpeg + pnpm:**

```bash
brew install node ffmpeg
corepack enable        # abilita pnpm; se "command not found: corepack" → brew install pnpm
```

**Blocco 3 — Verifica che siano raggiungibili DA QUI (il passo che la scheda Code fa spesso fallire):**

```bash
command -v node pnpm ffmpeg
node -v        # deve essere ≥ 20
pnpm -v
ffmpeg -version | head -1
```

Se uno di questi NON risponde anche se l'hai appena installato → **è il PATH**. Forzalo nella sessione e rendilo persistente, poi ri-verifica:

```bash
# Apple Silicon (su Intel: /usr/local/bin)
export PATH="/opt/homebrew/bin:$PATH"
grep -q 'brew shellenv' ~/.zprofile 2>/dev/null || \
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
command -v node pnpm ffmpeg   # ora devono rispondere tutti
```

> **nvm / fnm**: se `command -v node` risolve sotto `~/.nvm/` o `~/.fnm/`, quel node è gestito dalla shell e la scheda Code potrebbe non vederlo nelle sessioni successive. Preferisci il node di Homebrew (più prevedibile); se l'utente vuole tenere nvm/fnm, assicurati che la `bin` del node attivo sia esportata in `~/.zprofile`.

### Linux / WSL2

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
corepack enable
command -v node pnpm ffmpeg && node -v && pnpm -v
```

Su Windows nativo: `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg` + `corepack enable`, poi **riapri** l'app/terminale (il PATH si aggiorna alla riapertura). Dettagli ed equivalenti POSIX in `docs/PORTING-WINDOWS.md`.

## Step 2 — Metti il motore al suo posto

Il motore arriva come **file ZIP** (`reel-engine-v1.x.x.zip`) da Michel o dalla cartella Drive condivisa. NON si clona da GitHub.

1. Scompatta lo ZIP: su Mac doppio click → cartella `reel-engine`; su Windows click destro → Estrai tutto.
2. Spostala dove lavori (es. `~/Documents/reel-engine`) e aprila come cartella di lavoro in Claude.
3. Poi installa le dipendenze:

```bash
cd reel-engine
pnpm install
```

Se stai già lavorando dentro la cartella del motore (es. te l'ha consegnata Michel a un evento), salta lo scompattamento: sei già qui, vai direttamente a `pnpm install`.

## Step 3 — Chiavi API (PROPRIE, mai condivise)

```bash
cp .env.example .env
```

Compila `.env` con le chiavi **personali** dell'utente (ognuno paga i propri consumi):

| Chiave | Dove crearla | Serve per | Costo tipico |
|---|---|---|---|
| `FAL_KEY` | fal.ai → Dashboard → Keys | video Kling | ~$0.50/clip 5s, ~$5-7/reel |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | elevenlabs.io → Settings → API Keys | voiceover | ~$0.30/reel |
| `GOOGLE_API_KEY` | aistudio.google.com/apikey | keyframe storyboard + audit | ~$0.06-0.10/keyframe |

- La `GOOGLE_API_KEY` può iniziare con `AIza...` o con `AQ.` (nuovo formato Google) — **vanno bene entrambe**. Il gate vero di Google è la **fatturazione attiva sul progetto**, non il prefisso.
- Se l'utente **non ha il `ELEVENLABS_VOICE_ID`**: aiutalo a prenderlo da elevenlabs.io (**Voices → My Voices → tre puntini sulla voce → Copy voice ID**, ~20 caratteri), oppure usa la voce ufficiale che fornisce Michel.
- Le altre variabili in `.env.example` sono opzionali — non toccarle al primo setup.

## Step 4 — Verifica (gratis)

```bash
pnpm exec tsc --noEmit   # il progetto compila
pnpm reel --help          # la CLI risponde e mostra il workflow
```

Se `tsc` o la CLI falliscono, NON proseguire: leggi l'errore (il motore ha messaggi parlanti, es. "Prerequisiti mancanti: ffmpeg" con le istruzioni). Se l'errore è `command not found` su node/pnpm/ffmpeg → torna allo Step 1, blocco 3 (PATH).

## Step 5 — Primo test reale (~$0.30)

Avvisa l'utente del costo, poi genera SOLO la voce dal template di esempio:

```bash
pnpm reel <path-al-template-script-esempio.json> --audio-only
```

Il template è in `templates/script-esempio.json` di questa skill (copialo nella cartella di lavoro). Se esce un `voiceover.mp3` ascoltabile → setup completo.

## Da qui in poi

La produzione vera passa dalla skill **reel-director** (workflow a 4 gate). Il manuale operativo completo è il `CLAUDE.md` del repo — quando lavori nella cartella del repo lo leggi automaticamente.

## Troubleshooting rapido

| Errore | Fix |
|---|---|
| `command not found: brew` | Homebrew non installato o non nel PATH di questa sessione: Step 1, blocco 1 (install + `eval brew shellenv`) |
| `command not found: node` / `pnpm` / `ffmpeg` **dopo** averli installati | È il PATH della scheda Code/GUI: Step 1, blocco 3 (`export PATH="/opt/homebrew/bin:$PATH"` su Apple Silicon, `/usr/local/bin` su Intel + persisti in `~/.zprofile`) |
| `Prerequisiti mancanti: ffmpeg` | Step 1, poi ri-verifica con `command -v ffmpeg` (può essere il PATH, non l'install) |
| `ELEVENLABS_API_KEY not set` | `.env` mancante o vuoto nella root del repo |
| `ELEVENLABS_VOICE_ID` mancante | Prendilo dai preferiti su elevenlabs.io (Copy voice ID) o usa quello ufficiale di Michel (Step 3) |
| `403` da fal.ai | Saldo esaurito sull'account fal dell'utente: ricaricare su fal.ai/dashboard/billing |
| chiave Google non parte / "not available on free tier" | Fatturazione non attiva sul progetto della chiave: attivala (Set up billing + $10). `AIza` e `AQ.` vanno bene entrambe |
| Node < 20 | `brew upgrade node` / reinstalla LTS |
| Windows: comandi `touch`/`open` non esistono | Equivalenti in `docs/PORTING-WINDOWS.md` (`New-Item`, `Invoke-Item`) |
