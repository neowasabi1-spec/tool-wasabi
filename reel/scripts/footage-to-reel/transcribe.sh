#!/bin/bash
# Trascrive UN video in JSON con word-timestamps (mlx-whisper large-v3, ITA, anti-loop).
# --condition-on-previous-text False evita i loop di allucinazione su audio quieto/lungo.
# Uso: transcribe.sh <video.mp4> [output-dir]
# Output: <output-dir>/<base>.json   (default output-dir = stessa cartella del video)
set -e
SRC="$1"; OUTDIR="${2:-$(dirname "$SRC")}"
[ -z "$SRC" ] && { echo "Uso: transcribe.sh <video.mp4> [output-dir]"; exit 1; }
VENV="$HOME/.cache/footage-reel/venv"
[ -x "$VENV/bin/mlx_whisper" ] || { echo "venv mancante: lancia prima ./setup.sh"; exit 1; }
MODEL="${FR_WHISPER_MODEL:-mlx-community/whisper-large-v3-mlx}"
base=$(basename "${SRC%.*}")
wav="$(mktemp -t footagereel).wav"
echo "[transcribe] estraggo audio: $base"
ffmpeg -y -i "$SRC" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$wav" 2>/dev/null
echo "[transcribe] mlx-whisper (anti-loop)..."
mkdir -p "$OUTDIR"
"$VENV/bin/mlx_whisper" "$wav" --model "$MODEL" --language Italian --task transcribe \
  --word-timestamps True --condition-on-previous-text False \
  --output-format json --output-dir "$OUTDIR" --output-name "$base" >/dev/null
rm -f "$wav"
# sanity: % segmenti duplicati (loop residuo?)
"$VENV/bin/python" - "$OUTDIR/$base.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); s=[x["text"].strip() for x in d.get("segments",[])]
dup=1-len(set(s))/max(1,len(s))
print(f"[transcribe] OK {sys.argv[1]}  ({d['segments'][-1]['end']/60:.0f}min, dup {dup*100:.0f}%)"
      + ("  ⚠️ loop residuo: rilancia o verifica audio" if dup>30 else ""))
PY
