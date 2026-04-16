@echo off
title OpenClaw Worker
cd /d "%~dp0"
echo Starting OpenClaw Worker...
echo (leave this window open — close it to stop the worker)
echo.
:loop
node openclaw-worker.js
echo.
echo Worker exited. Restarting in 5 seconds... (Ctrl+C to cancel)
timeout /t 5 /nobreak >nul
goto loop
