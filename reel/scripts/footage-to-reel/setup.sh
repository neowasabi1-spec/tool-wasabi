#!/bin/bash
# Setup one-time per macchina: crea il venv Python con mlx-whisper (trascrizione
# veloce su Apple Silicon, ~10-12x realtime) + Pillow. Idempotente.
# Lancialo una volta su ogni Mac (MacBook + Mac Mini).
set -e
VENV="$HOME/.cache/footage-reel/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "Creo venv in $VENV ..."
  mkdir -p "$(dirname "$VENV")"
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet mlx-whisper Pillow
"$VENV/bin/python" -c "import mlx_whisper, PIL; print('OK: mlx-whisper + Pillow pronti in', '$VENV')"
