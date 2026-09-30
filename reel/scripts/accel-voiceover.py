#!/usr/bin/env python3
"""Accelera il voiceover di un reel via ffmpeg atempo + riscala word-timestamps.

Uso: python3 scripts/accel-voiceover.py <reelDir> <atempo> [pitch_semitoni]
Es.:  python3 scripts/accel-voiceover.py ~/Movies/reel-ai/2026-06-11/reel-3331 1.15
      python3 scripts/accel-voiceover.py ~/Movies/reel-ai/2026-06-15/reel-2279 1.25 -1

- Al primo run salva i raw in assets/voiceover-raw.mp3 + word-timestamps-raw.json.
- Ogni run successivo riparte SEMPRE dai raw (niente compounding): puoi iterare
  il fattore quante volte vuoi a costo zero.
- Dopo: pnpm reel <script> --sync-only --from <reelDir> per riallineare le scene.

Perché esiste: il campo voiceSettings.speed su eleven_v3 è inaffidabile
(take 1.2 uscito più lento del take 1.05, 2026-06-11); atempo è la leva certa.

pitch_semitoni (opzionale, default 0): abbassa/alza il PITCH senza toccare la
durata, per voci eleven_v3 uscite troppo acute/gravi (es. -1 = un semitono giù,
validato un cliente Variante B 2026-06-15). atempo preserva il pitch, quindi serve
asetrate+atempo. Il fattore di DURATA resta <atempo>: i word-timestamps si
riscalano solo su quello (il pitch non cambia la durata)."""
import json
import os
import shutil
import subprocess
import sys

if len(sys.argv) not in (3, 4):
    sys.exit(__doc__)

reel_dir = os.path.expanduser(sys.argv[1])
factor = float(sys.argv[2])               # fattore TEMPO netto (durata = raw / factor)
pitch_semitones = float(sys.argv[3]) if len(sys.argv) == 4 else 0.0
if not 0.5 <= factor <= 2.0:
    sys.exit("atempo fuori range ffmpeg single-pass (0.5-2.0)")

aud = os.path.join(reel_dir, "assets", "voiceover.mp3")
raw = os.path.join(reel_dir, "assets", "voiceover-raw.mp3")
wt = os.path.join(reel_dir, "word-timestamps.json")
wt_raw = os.path.join(reel_dir, "word-timestamps-raw.json")

for p in (aud, wt):
    if not os.path.exists(p):
        sys.exit(f"manca {p}")

if not os.path.exists(raw):
    shutil.copy(aud, raw)
if not os.path.exists(wt_raw):
    shutil.copy(wt, wt_raw)

# Costruzione filtro audio. Senza pitch: solo atempo (preserva il pitch, come sempre).
# Con pitch: asetrate sposta pitch+tempo, atempo ricorregge il tempo → pitch ×p,
# durata ×factor. La durata netta resta `factor`, quindi i timestamp si riscalano
# solo su quello (vedi sotto), indipendentemente dal pitch.
if pitch_semitones == 0.0:
    af = f"atempo={factor}"
else:
    p = 2 ** (pitch_semitones / 12.0)
    sr = int(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate", "-of", "csv=p=0", raw],
        capture_output=True, text=True,
    ).stdout.strip())
    q = factor / p
    if not 0.5 <= q <= 2.0:
        sys.exit(f"atempo corretto {q:.3f} fuori range single-pass (0.5-2.0): riduci |pitch| o factor")
    af = f"asetrate={round(sr * p)},aresample={sr},atempo={q}"

subprocess.run(
    ["ffmpeg", "-hide_banner", "-y", "-i", raw, "-af", af,
     "-codec:a", "libmp3lame", "-q:a", "2", aud],
    check=True, capture_output=True,
)

words = json.load(open(wt_raw))
for w in words:
    w["startSec"] = round(w["startSec"] / factor, 3)
    w["endSec"] = round(w["endSec"] / factor, 3)
json.dump(words, open(wt, "w"), ensure_ascii=False, indent=0)

dur = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", aud],
    capture_output=True, text=True,
).stdout.strip()
pitch_note = f", pitch {pitch_semitones:+g} st" if pitch_semitones else ""
print(f"OK atempo {factor}x{pitch_note} -> {aud} ({float(dur):.1f}s, {len(words)} parole)")
print(f"Ora: pnpm reel <script> --sync-only --from \"{reel_dir}\"")
