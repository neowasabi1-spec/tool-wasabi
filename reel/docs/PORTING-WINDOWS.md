# Reel Engine su Windows — guida di porting

> **A chi è rivolto questo documento**: a Claude Code in esecuzione sul PC Windows di un collaboratore. Se sei l'agente: segui le istruzioni qui sotto per far girare il motore su questa macchina, applica gli adattamenti minimi necessari e segnala a Michel ogni fix di codice che fai, così viene mergiato upstream.

> **All'evento si lavora in NATIVO → vai all'Opzione B.** Serve solo Git for Windows come shell, poi Node + ffmpeg via `winget`. WSL2 (Opzione A) è un **fallback**, non il default: usalo solo se il nativo si blocca.

## Opzione A — WSL2 (fallback, zero modifiche al codice)

Il motore è sviluppato e testato su macOS/Linux. In WSL2 funziona così com'è. È un'alternativa solo se il percorso nativo (Opzione B) ti dà problemi.

```bash
# In PowerShell (admin), una volta sola:
wsl --install -d Ubuntu

# Dentro Ubuntu:
sudo apt update && sudo apt install -y ffmpeg
curl -fsSL https://fnm.vercel.app/install | bash   # oppure nvm
fnm install 22 && fnm use 22
corepack enable
cd <cartella-reel-engine> && pnpm install
cp .env.example .env   # poi compila le chiavi
```

Note WSL2:
- Tieni il progetto **nel filesystem Linux** (`~/reel-engine`), non in `/mnt/c/...`: l'I/O su `/mnt/c` è lento e il render Remotion ne soffre.
- Output: di default `~/Movies/reel-ai` dentro WSL. Per averli visibili da Windows imposta nel `.env`: `REEL_OUTPUT_BASE=/mnt/c/Users/<utente>/Videos/reel-ai` (accetti l'I/O più lento solo sui file finali).
- I file generati si aprono da Windows con `explorer.exe .` dalla cartella del reel.

## Opzione B — Windows nativo (CONSIGLIATA — è il percorso usato all'evento)

Dal 2026-06-10 il core della pipeline è cross-platform (copie file via `node:fs`, output base su `os.homedir()`, auto-open disattivo di default, whisper risolto dal PATH). Restano i punti sotto.

### Prerequisiti

```powershell
winget install OpenJS.NodeJS.LTS     # Node ≥ 20
corepack enable                       # abilita pnpm
winget install Gyan.FFmpeg            # ffmpeg + ffprobe nel PATH
# Solo se serve il workflow refresh-creativo:
winget install Python.Python.3.12
pip install openai-whisper
```

Riapri il terminale dopo le installazioni (PATH aggiornato). Verifica: `ffmpeg -version`, `node -v`, `pnpm -v`.

### Setup

```powershell
cd reel-engine
pnpm install
Copy-Item .env.example .env
# compila .env con le TUE chiavi (vedi README.md)
```

Consigliato nel `.env` (su Windows la cartella "Movies" non esiste, meglio Videos):

```
REEL_OUTPUT_BASE=C:\Users\<utente>\Videos\reel-ai
```

### Differenze operative da conoscere

| Su macOS si fa | Su Windows nativo |
|---|---|
| `touch <reel-dir>/assets/keyframes/scene-N.png.approved` (GATE 4) | `New-Item "<reel-dir>\assets\keyframes\scene-N.png.approved"` |
| `open "<path>"` (comando stampato nei log per aprire audio/video) | `Invoke-Item "<path>"` oppure `start "" "<path>"` |
| simlink `output-movies` nella root del progetto | Ignoralo: è un alias comodo per macOS. Usa direttamente la cartella di `REEL_OUTPUT_BASE` |
| `--auto-open` apre QuickTime | No-op su Windows (per design): apri i file con Invoke-Item |

### Cosa NON è supportato nativo (usa WSL2 se ti serve)

- Gli script one-off Python in `scripts/` (`accel-splice-v2.py`, `build-*.py`): non fanno parte del flusso standard.
- `pnpm higgsfield:auth`: servizio deprecato dal 2026-05-28, non serve a nessun workflow attuale.
- Veo backend `vertex` (richiede gcloud CLI): il default `VEO_BACKEND=gemini` funziona ovunque con la sola `GOOGLE_API_KEY`.

### Verifica del porting (in ordine, costo ~$0.30 totale)

```powershell
pnpm exec tsc --noEmit                 # 1. compila
pnpm reel --help                       # 2. la CLI parte e mostra l'help
pnpm reel <script-test> --audio-only   # 3. primo run vero: solo voce (~$0.30)
# 4. se l'audio esce: pnpm storyboard + gate + --video-only come da README
```

### Istruzioni per l'agente (Claude Code del collaboratore)

1. Prima di toccare il codice, esegui la "Verifica del porting" sopra: con i fix 2026-06-10 è probabile che funzioni già tutto.
2. Se incontri un punto POSIX-only non elencato qui (un comando shell unix, un path hardcoded), correggilo con l'equivalente portabile (`node:fs/promises`, `path.join`, guardia `process.platform`) — non con un workaround locale.
3. Documenta ogni modifica fatta e falla avere a Michel (ms@michelsainville.com) per il merge upstream: il motore deve restare UNA codebase, non N fork.
4. Non modificare mai la logica dei gate (GATE 1-4) né i default di spesa: sono scelte di processo, non dettagli tecnici.
