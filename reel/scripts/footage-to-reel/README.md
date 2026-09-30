# footage-to-reel

Trasforma **footage parlato esistente** (consulenze, pitch, podcast registrati col DJI/telefono) in **short verticali per Instagram** con sottotitoli **kinetic** del reel-engine e **la voce originale** (niente ElevenLabs).

Costruito il 2026-06-22 sul batch "Video DJI → 22 reel". L'insight chiave: il sistema kinetic del reel-engine (`subtitleStyle.kinetic`, componenti `KineticSubtitle` "rise" / `KineticCaptionsArt` "motion") si pilota su footage esistente con un `composition-props.json` per `BasicReel` che ha una scena con `videoUrl` e **senza** `voiceoverUrl` → il clip suona a volume 1 (voce originale) e i sottotitoli sono sincronizzati sui word-timestamps whisper.

## Setup (una volta per macchina)

```bash
cd reel-engine/scripts/footage-to-reel
./setup.sh          # crea ~/.cache/footage-reel/venv con mlx-whisper + Pillow
```
Richiede anche: `reel-engine` con `pnpm install` fatto, e `ffmpeg`.

## Pipeline (per ogni video)

```bash
# 1) TRASCRIVI (mlx-whisper large-v3, anti-loop, ~10x realtime)
./transcribe.sh "/percorso/video.mp4" /tmp/transcripts
#    -> /tmp/transcripts/<base>.json  (word-timestamps)

# 2) SCEGLI I MOMENTI  (passo di giudizio - lo fa Claude leggendo il transcript)
#    Regole: solo dove MICHEL insegna un principio UNIVERSALE e AUTONOMO,
#    ogni reel APRE SU UN HOOK (claim forte / numero / domanda provocatoria),
#    niente call interne, niente name-heavy, niente interviste (ospite che parla).
#    Su recording lunghi conviene fan-out di agenti di scansione (vedi storia chat 2026-06-22).

# 3) RENDERIZZA ogni momento (un reel per chiamata)
./footage-reel.sh "/percorso/video.mp4" <start> <end> <rise|motion> /tmp/transcripts/<base>.json <out-name> <reframe> ["TIME=fix"...]
#    es:
./footage-reel.sh ".../DJI_0021.mp4" 527.44 589.05 motion /tmp/transcripts/DJI_0021.json "momento-peggiore" none "529.06=a"
#    -> "Reel da pubblicare/momento-peggiore.mp4"
```

## reframe

| valore | quando |
|--------|--------|
| `none` | sorgente già 9:16 (verticale 1080x1920 o 1728x3072) → solo scale |
| `vcrop<X>` | sorgente landscape (1920x1080, 4K 3840x2160): crop verticale 9:16 con offset orizzontale X px sul parlante. Frame-check un fotogramma a metà finestra per scegliere X |
| `blur` | podcast a 2 persone / quando il crop taglierebbe il soggetto: frame intero su sfondo sfocato (entrambi visibili) |

## Varianti sottotitoli (alterna tra reel)

- `rise` — `KineticSubtitle`: parole che salgono a onda, parola attiva in oro, safe-zone alta. Font Inter.
- `motion` — `KineticCaptionsArt`: motion typography, font Anton, parola-hero ingrandita+glow, banda bassa.

## Output

Default in `clienti/michel-sainville-studio/Reel da pubblicare/`. Override con `FR_OUTDIR=/altra/cartella`.

## Note / gotcha

- **Anti-loop obbligatorio**: senza `--condition-on-previous-text False` mlx-whisper su audio lungo/quieto entra in loop di allucinazione (verificato: 0009 da 95min andò in loop totale al primo giro). `transcribe.sh` lo applica e segnala se restano duplicati >30%.
- **make_subs.py** ricuce le elisioni che whisper spezza ("l" + "'azienda" → "l'azienda") e accetta correzioni refuso `--fix "TIME=parola"`.
- **Hook-first**: il taglio deve PARTIRE sulla frase-gancio, non sul lead-in ("Perché data la sua struttura..." = molle; "I clienti mentono" = hook). Lezione dal batch: stesso contenuto, +2 punti di voto solo spostando lo start sull'hook.
- **`pnpm render`** bundla Remotion ad ogni chiamata (~30-60s overhead). Per molti reel è comunque accettabile; un batch bundle-once è un'ottimizzazione futura.
