#!/bin/bash
# Produce UN reel kinetic da footage ESISTENTE, preservando l'audio originale.
# Usa il reel-engine (composition BasicReel + subtitleStyle.kinetic): una scena con
# `videoUrl` e SENZA `voiceoverUrl` -> il clip suona a volume 1 (voce originale) e i
# sottotitoli kinetic (KineticSubtitle "rise" / KineticCaptionsArt "motion") sono
# sincronizzati sui word-timestamps whisper passati come `subtitles`.
#
# Uso: footage-reel.sh <video> <startSec> <endSec> <rise|motion> <transcript.json> <outName> <reframe> [fix ...]
#   reframe: none           -> sorgente gia 9:16 (solo scale 1080x1920)
#            vcrop<X>        -> landscape: crop verticale 9:16 con x-offset X (es. vcrop656)
#            blur            -> frame intero su sfondo sfocato (podcast/2 persone, niente crop)
#   fix:     "TIME=testo"    -> corregge un refuso del sottotitolo (t0 parola ~= TIME)
# Output:   $FR_OUTDIR/<outName>.mp4   (default = Michel studio "Reel da pubblicare")
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$(cd "$SCRIPT_DIR/../.." && pwd)"          # reel-engine root
VENV="$HOME/.cache/footage-reel/venv"; PY="$VENV/bin/python"
OUTDIR="${FR_OUTDIR:-/Users/msainville/Desktop/AI-Clienti/clienti/michel-sainville-studio/Reel da pubblicare}"

SRC="$1"; START="$2"; END="$3"; VARIANT="$4"; JSON="$5"; OUT="$6"; REFRAME="$7"; shift 7
FIXARGS=(); for fx in "$@"; do FIXARGS+=(--fix "$fx"); done
DUR=$(echo "$END - $START" | bc -l)
FRAMES=$(printf "%.0f" "$(echo "($END - $START) * 30 - 1" | bc -l)")
RDIR="$(mktemp -d /tmp/footage-reel.XXXXXX)"; mkdir -p "$RDIR/assets"

# 1) taglio + reframe del clip (audio originale incluso)
read W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$SRC" | tr ',' ' ')
ENCO=(-dn -map_chapters -1 -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset medium -c:a aac -b:a 192k -movflags +faststart)
if [[ "$REFRAME" == blur ]]; then
  FC="[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:8[bg];[0:v]scale=1080:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]"
  ffmpeg -y -ss "$START" -t "$DUR" -i "$SRC" -filter_complex "$FC" -map "[v]" -map 0:a:0 "${ENCO[@]}" "$RDIR/assets/clip.mp4" 2>/dev/null
else
  if [[ "$REFRAME" == vcrop* ]]; then
    X="${REFRAME#vcrop}"; CROPW=$(printf "%.0f" "$(echo "$H * 9 / 16" | bc -l)")
    VF="crop=${CROPW}:${H}:${X}:0,scale=1080:1920"
  else
    VF="scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
  fi
  ffmpeg -y -ss "$START" -t "$DUR" -i "$SRC" -vf "$VF" "${ENCO[@]}" "$RDIR/assets/clip.mp4" 2>/dev/null
fi

# 2) sottotitoli kinetic dai word-timestamps
SUBS=$("$PY" "$SCRIPT_DIR/make_subs.py" --json "$JSON" --start "$START" --end "$END" --fps 30 --lead 0.0 "${FIXARGS[@]}")

# 3) composition-props.json per BasicReel (footage + audio originale + kinetic)
"$PY" - "$SUBS" "$FRAMES" "$VARIANT" "$RDIR" <<'PYEOF'
import json, sys
subs=json.loads(sys.argv[1]); frames=int(sys.argv[2]); variant=sys.argv[3]; rdir=sys.argv[4]
props={"compositionId":"BasicReel","durationInFrames":frames,
  "props":{"hook":"","cta":"","scenes":[{"text":"","videoUrl":"assets/clip.mp4","durationInFrames":frames}],
           "subtitles":subs,"subtitleStyle":{"kinetic":True,"variant":variant}}}
json.dump(props, open(f"{rdir}/composition-props.json","w"), ensure_ascii=False, indent=2)
print(f"  {len(subs)} parole, {frames}f ({frames/30:.0f}s), {variant}")
PYEOF

# 4) render + consegna
( cd "$ENGINE" && pnpm render "$RDIR" 2>&1 | tail -1 )
mkdir -p "$OUTDIR"; cp "$RDIR/final.mp4" "$OUTDIR/$OUT.mp4"; rm -rf "$RDIR"
echo "  -> $OUTDIR/$OUT.mp4"
