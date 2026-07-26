#!/bin/sh
# Fly.io container entrypoint.
#
# Runs the Next.js server in the foreground (keeps the machine alive and serves
# HTTP / health checks) and the video segment/build worker in the background so
# competitor-video shot extraction + recreation happen ONLINE — no local PC.
#
# The worker auto-restarts if it crashes. It reads SUPABASE_SERVICE_ROLE_KEY
# (already a Fly secret used by the app) for storage read/write.

# Background: video worker, restart-on-crash loop.
(
  while true; do
    node video-segment-worker.js
    echo "[start] video worker exited (code $?), restarting in 3s..."
    sleep 3
  done
) &

# Foreground: the web server. Container lifecycle follows this process.
exec node server.js
